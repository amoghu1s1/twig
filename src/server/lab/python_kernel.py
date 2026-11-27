#!/usr/bin/env python3
"""
Persistent local Python worker for Twig Lab notebooks.
Zero external dependencies (stdlib only, compatible with Python 3.9 - 3.14+).
Speaks newline-delimited JSON over a loopback TCP socket authenticated via
TWIG_KERNEL_PORT and TWIG_KERNEL_TOKEN.
"""

from __future__ import annotations

import _thread
import ast
import base64
import builtins
from datetime import datetime, timezone
import importlib
import io
import json
import os
import queue
import signal
import socket
import sys
import threading
import time
import traceback
import types
from typing import Any

# Ensure headless Matplotlib rendering before user code imports pyplot.
os.environ.setdefault("MPLBACKEND", "Agg")

KERNEL_FILE = os.path.abspath(__file__)
MAX_VAR_ITEMS = 64
MAX_REPR_CHARS = 120

_send_lock = threading.Lock()
_sock: socket.socket | None = None
_namespace: dict[str, Any] = {
    "__name__": "__main__",
    "__doc__": None,
    "__package__": None,
}
_execution_count = 0
_orig_import = builtins.__import__
_current_exec_id: str | None = None
_active_outputs: list[dict[str, Any]] = []
_module_mtimes: dict[str, int] = {}


def _send_event(payload: dict[str, Any]) -> None:
    if _sock is None:
        return
    line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8", errors="replace")
    with _send_lock:
        try:
            _sock.sendall(line)
        except OSError:
            pass


class _StreamWriter(io.TextIOBase):
    def __init__(self, stream_name: str) -> None:
        self._stream_name = stream_name

    @property
    def encoding(self) -> str:  # type: ignore[override]
        return "utf-8"

    @property
    def errors(self) -> str:  # type: ignore[override]
        return "replace"

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def write(self, s: str) -> int:
        if not isinstance(s, str):
            s = str(s)
        if s and _current_exec_id is not None:
            _send_event({
                "type": "stream",
                "cellId": _current_exec_id,
                "name": self._stream_name,
                "text": s,
            })
        return len(s)

    def flush(self) -> None:
        return None


def _emit_display_data(data: dict[str, str]) -> None:
    if not data or _current_exec_id is None:
        return
    out = {"outputType": "display_data", "data": data}
    _active_outputs.append(out)
    _send_event({
        "type": "output",
        "cellId": _current_exec_id,
        "output": out,
    })


def _flush_open_figures() -> None:
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    try:
        fig_nums = list(plt.get_fignums())
    except Exception:
        return
    for num in fig_nums:
        try:
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=144, bbox_inches="tight")
            plt.close(fig)
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            _emit_display_data({"image/png": b64})
        except Exception:
            try:
                plt.close(num)
            except Exception:
                pass


def _hook_pyplot() -> None:
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    current_show = getattr(plt, "show", None)
    if current_show is None or getattr(current_show, "_twig_hooked", False):
        return

    def _twig_show(*_args: Any, **_kwargs: Any) -> None:
        _flush_open_figures()

    _twig_show._twig_hooked = True  # type: ignore[attr-defined]
    plt.show = _twig_show


def _twig_import(name: str, globals: Any = None, locals: Any = None, fromlist: Any = (), level: int = 0) -> Any:
    mod = _orig_import(name, globals, locals, fromlist, level)
    if "matplotlib" in name:
        _hook_pyplot()
    return mod


def _extract_mime_bundle(val: Any) -> dict[str, str]:
    data: dict[str, str] = {}
    if val is None:
        return data

    # Matplotlib Figure returned directly as last expression
    if type(val).__name__ == "Figure" and "matplotlib" in type(val).__module__:
        try:
            buf = io.BytesIO()
            val.savefig(buf, format="png", dpi=144, bbox_inches="tight")
            data["image/png"] = base64.b64encode(buf.getvalue()).decode("ascii")
            plt = sys.modules.get("matplotlib.pyplot")
            if plt is not None:
                try:
                    plt.close(val)
                except Exception:
                    pass
            return data
        except Exception:
            pass

    # PIL Image
    if "PIL." in type(val).__module__ and hasattr(val, "save"):
        try:
            buf = io.BytesIO()
            val.save(buf, format="PNG")
            data["image/png"] = base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            pass

    for attr, mime in (
        ("_repr_png_", "image/png"),
        ("_repr_svg_", "image/svg+xml"),
        ("_repr_html_", "text/html"),
    ):
        fn = getattr(val, attr, None)
        if callable(fn):
            try:
                res = fn()
                if isinstance(res, bytes):
                    res = base64.b64encode(res).decode("ascii")
                if isinstance(res, str) and res:
                    data[mime] = res
            except Exception:
                pass

    try:
        plain = repr(val)
    except Exception as exc:
        plain = f"<unprintable {type(val).__name__}: {exc}>"
    if len(plain) > 20_000:
        plain = plain[:20_000] + "\n... [repr truncated]"
    data["text/plain"] = plain
    return data


def _format_traceback(exc: BaseException, cell_filename: str) -> list[str]:
    tb = traceback.TracebackException.from_exception(exc)
    # Remove worker-internal frames so line numbers stay grounded in cell code.
    filtered = [frame for frame in tb.stack if os.path.abspath(frame.filename) != KERNEL_FILE]
    if filtered:
        tb.stack = traceback.StackSummary.from_list(filtered)
    lines: list[str] = []
    for chunk in tb.format():
        for line in chunk.splitlines():
            lines.append(line)
    return lines


def _safe_len(val: Any) -> int | None:
    try:
        return len(val)
    except Exception:
        return None


def _truncate(text: str, limit: int = MAX_REPR_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _collect_vars() -> list[dict[str, Any]]:
    vars_out: list[dict[str, Any]] = []
    for name, val in list(_namespace.items()):
        if name.startswith("_") or name in ("In", "Out"):
            continue
        if isinstance(val, types.ModuleType):
            continue
        if isinstance(val, (types.FunctionType, types.BuiltinFunctionType, type)):
            continue
        type_obj = type(val)
        type_name = type_obj.__name__
        mod_name = type_obj.__module__

        entry: dict[str, Any] = {
            "name": name,
            "typeName": type_name,
            "summary": "",
        }

        try:
            # NumPy ndarray / scalar
            if mod_name == "numpy" and type_name == "ndarray":
                shape = [int(d) for d in val.shape]
                dtype = str(val.dtype)
                entry["shape"] = shape
                entry["dtype"] = dtype
                entry["sizeHint"] = f"{val.size} elems"
                if val.size <= 8:
                    entry["summary"] = _truncate(repr(val.tolist()))
                else:
                    entry["summary"] = f"ndarray{tuple(shape)} {dtype}"
            # PyTorch Tensor
            elif mod_name.startswith("torch") and type_name in ("Tensor", "Parameter"):
                shape = [int(d) for d in val.shape]
                dtype = str(val.dtype).replace("torch.", "")
                device = str(val.device)
                entry["shape"] = shape
                entry["dtype"] = dtype
                entry["device"] = device
                entry["sizeHint"] = "grad" if getattr(val, "requires_grad", False) else f"{val.numel()} elems"
                if val.numel() <= 6 and device == "cpu":
                    entry["summary"] = _truncate(repr(val.detach().tolist()))
                else:
                    entry["summary"] = f"Tensor{tuple(shape)} {dtype} ({device})"
            # PyTorch nn.Module
            elif mod_name.startswith("torch") or any(
                b.__module__.startswith("torch.nn") and b.__name__ == "Module"
                for b in type_obj.__mro__
            ):
                if hasattr(val, "parameters") and callable(val.parameters):
                    try:
                        total_params = sum(int(p.numel()) for p in val.parameters())
                        entry["sizeHint"] = f"{total_params:,} params"
                        entry["summary"] = f"{type_name} ({total_params:,} params)"
                    except Exception:
                        entry["summary"] = _truncate(repr(val))
                else:
                    entry["summary"] = _truncate(repr(val))
            # Pandas DataFrame / Series
            elif mod_name.startswith("pandas") and type_name in ("DataFrame", "Series"):
                shape = [int(d) for d in val.shape]
                entry["shape"] = shape
                if type_name == "DataFrame":
                    cols = [str(c) for c in list(val.columns)[:4]]
                    suffix = ", …" if len(val.columns) > 4 else ""
                    entry["summary"] = f"({shape[0]}×{shape[1]}) cols=[{', '.join(cols)}{suffix}]"
                else:
                    entry["dtype"] = str(val.dtype)
                    entry["summary"] = f"Series({shape[0]}) {val.dtype}"
            elif isinstance(val, (list, tuple, dict, set, frozenset)):
                length = _safe_len(val)
                if length is not None:
                    entry["sizeHint"] = f"len={length}"
                entry["summary"] = _truncate(repr(val))
            else:
                entry["summary"] = _truncate(repr(val))
        except Exception as exc:
            entry["summary"] = f"<{type_name}: {exc}>"

        vars_out.append(entry)
        if len(vars_out) >= MAX_VAR_ITEMS:
            break
    return vars_out


def _run_standard_cell(code: str, filename: str, exec_count: int) -> None:
    tree = ast.parse(code, filename=filename, mode="exec")
    if not tree.body:
        return
    last = tree.body[-1]
    if isinstance(last, ast.Expr):
        prefix = ast.Module(body=tree.body[:-1], type_ignores=[])
        ast.fix_missing_locations(prefix)
        if prefix.body:
            exec(compile(prefix, filename, "exec"), _namespace)
        expr = ast.Expression(body=last.value)
        ast.fix_missing_locations(expr)
        value = eval(compile(expr, filename, "eval"), _namespace)
        if value is not None:
            mime_data = _extract_mime_bundle(value)
            out = {
                "outputType": "execute_result",
                "executionCount": exec_count,
                "data": mime_data,
            }
            _active_outputs.append(out)
            _send_event({"type": "output", "cellId": _current_exec_id, "output": out})
    else:
        exec(compile(tree, filename, "exec"), _namespace)


def _is_workspace_module(mod: Any, workspace_real: str) -> str | None:
    if not isinstance(mod, types.ModuleType):
        return None
    if getattr(mod, "__name__", "") in ("__main__", "builtins"):
        return None
    mod_file = getattr(mod, "__file__", None)
    if not isinstance(mod_file, str) or not mod_file.endswith(".py"):
        return None
    try:
        real_file = os.path.realpath(mod_file)
    except OSError:
        return None
    if not real_file.startswith(workspace_real + os.sep):
        return None
    for marker in ("/.venv/", "/venv/", "/env/", "/site-packages/", "/dist-packages/"):
        norm = real_file.replace(os.sep, "/")
        if marker in norm:
            return None
    return real_file


def _snapshot_workspace_mtimes(workspace_real: str) -> None:
    for mod in list(sys.modules.values()):
        real_file = _is_workspace_module(mod, workspace_real)
        if not real_file or real_file in _module_mtimes:
            continue
        try:
            _module_mtimes[real_file] = os.stat(real_file).st_mtime_ns
        except OSError:
            pass


def _reload_workspace_modules(workspace_real: str) -> list[str]:
    reloaded: list[str] = []
    seen_files: set[str] = set()
    for _mod_name, mod in list(sys.modules.items()):
        real_file = _is_workspace_module(mod, workspace_real)
        if not real_file or real_file in seen_files or real_file not in _module_mtimes:
            continue
        seen_files.add(real_file)
        try:
            current_mtime = os.stat(real_file).st_mtime_ns
        except OSError:
            continue
        if current_mtime == _module_mtimes[real_file]:
            continue

        old_by_id: dict[int, str] = {}
        for attr_name, attr_val in list(vars(mod).items()):
            if attr_name.startswith("__"):
                continue
            old_by_id[id(attr_val)] = attr_name

        importlib.reload(mod)
        try:
            _module_mtimes[real_file] = os.stat(real_file).st_mtime_ns
        except OSError:
            _module_mtimes[real_file] = current_mtime

        for ns_key, ns_val in list(_namespace.items()):
            attr_name = old_by_id.get(id(ns_val))
            if attr_name and hasattr(mod, attr_name):
                _namespace[ns_key] = getattr(mod, attr_name)

        rel = os.path.relpath(real_file, workspace_real).replace(os.sep, "/")
        reloaded.append(rel)
    return reloaded


def _run_check_cell(code: str, filename: str) -> dict[str, Any]:
    tree = ast.parse(code, filename=filename, mode="exec")
    test_fns: list[tuple[str, int]] = []
    cases: list[dict[str, Any]] = []
    first_exc: BaseException | None = None

    try:
        for stmt in tree.body:
            if isinstance(stmt, ast.Assert):
                try:
                    label = f"assert {ast.unparse(stmt.test)}" if hasattr(ast, "unparse") else f"assert (line {stmt.lineno})"
                except Exception:
                    label = f"assert (line {stmt.lineno})"
                mod = ast.Module(body=[stmt], type_ignores=[])
                ast.fix_missing_locations(mod)
                try:
                    exec(compile(mod, filename, "exec"), _namespace)
                    cases.append({"name": label[:120], "passed": True, "line": stmt.lineno})
                except KeyboardInterrupt:
                    raise
                except BaseException as exc:
                    msg = str(exc).strip()
                    if not msg:
                        msg = label if isinstance(exc, AssertionError) else f"{type(exc).__name__}: {exc}"
                    cases.append({
                        "name": label[:120],
                        "passed": False,
                        "message": msg[:240],
                        "line": stmt.lineno,
                    })
                    if first_exc is None:
                        first_exc = exc
            else:
                if isinstance(stmt, ast.FunctionDef) and stmt.name.startswith("test_"):
                    test_fns.append((stmt.name, stmt.lineno))
                mod = ast.Module(body=[stmt], type_ignores=[])
                ast.fix_missing_locations(mod)
                exec(compile(mod, filename, "exec"), _namespace)

        for fn_name, fn_line in test_fns:
            fn = _namespace.get(fn_name)
            if callable(fn):
                try:
                    fn()
                    cases.append({"name": f"{fn_name}()", "passed": True, "line": fn_line})
                except KeyboardInterrupt:
                    raise
                except BaseException as exc:
                    msg = str(exc).strip() or f"{type(exc).__name__} in {fn_name}()"
                    cases.append({
                        "name": f"{fn_name}()",
                        "passed": False,
                        "message": msg[:240],
                        "line": fn_line,
                    })
                    if first_exc is None:
                        first_exc = exc
    except KeyboardInterrupt:
        raise
    except BaseException as exc:
        cases.append({
            "name": "setup",
            "passed": False,
            "message": f"{type(exc).__name__}: {exc}"[:240],
            "line": getattr(exc, "lineno", None),
        })
        if first_exc is None:
            first_exc = exc

    total_checks = len(cases)
    passed_checks = sum(1 for c in cases if c.get("passed"))
    all_passed = (first_exc is None) and (passed_checks == total_checks)
    ran_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    final_total = max(1, total_checks)
    final_passed = passed_checks if total_checks > 0 else (1 if all_passed else 0)

    if all_passed:
        summary = f"{final_passed}/{final_total} checks passed" if total_checks > 0 else "Checks passed"
    else:
        failed_case = next((c for c in cases if not c.get("passed")), None)
        detail = failed_case.get("message") or failed_case.get("name") if failed_case else "Check failed"
        summary = f"{final_passed}/{final_total} checks passed — {detail}"

    result: dict[str, Any] = {
        "passed": all_passed,
        "checkPassed": all_passed,
        "status": "passed" if all_passed else "failed",
        "passedCount": final_passed,
        "totalCount": final_total,
        "summary": summary,
        "cases": cases,
        "ranAt": ran_at,
    }
    if first_exc is not None:
        result["exception"] = first_exc
    return result


def _handle_execute(cmd: dict[str, Any]) -> None:
    global _execution_count, _current_exec_id, _active_outputs
    cell_id = str(cmd.get("cellId") or "cell")
    code = str(cmd.get("code") or "")
    role = str(cmd.get("role") or "code")

    _execution_count += 1
    exec_count = _execution_count
    filename = f"<cell-{exec_count}>"
    _current_exec_id = cell_id
    _active_outputs = []

    cwd = os.getcwd()
    workspace_real = os.path.realpath(cwd) if cwd else ""
    if cwd and cwd not in sys.path:
        sys.path.insert(0, cwd)

    started = time.perf_counter()
    status = "ok"
    reloaded_modules: list[str] = []

    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout = _StreamWriter("stdout")
    sys.stderr = _StreamWriter("stderr")
    builtins.__import__ = _twig_import  # type: ignore[assignment]

    try:
        _hook_pyplot()
        if workspace_real:
            reloaded_modules = _reload_workspace_modules(workspace_real)
            if reloaded_modules:
                _send_event({
                    "type": "stream",
                    "cellId": cell_id,
                    "name": "stdout",
                    "text": f"[auto-reloaded: {', '.join(reloaded_modules)}]\n",
                })
        if role == "check":
            outcome = _run_check_cell(code, filename)
            exc = outcome.pop("exception", None)
            if exc is not None:
                status = "error"
                tb_lines = _format_traceback(exc, filename)
                err_out = {
                    "outputType": "error",
                    "ename": type(exc).__name__,
                    "evalue": str(exc),
                    "traceback": tb_lines,
                }
                _send_event({"type": "output", "cellId": cell_id, "output": err_out})
            _send_event({"type": "check_result", "cellId": cell_id, "result": outcome})
        else:
            _run_standard_cell(code, filename, exec_count)
        _hook_pyplot()
        _flush_open_figures()
    except KeyboardInterrupt as exc:
        status = "interrupted"
        tb_lines = _format_traceback(exc, filename)
        err_out = {
            "outputType": "error",
            "ename": "KeyboardInterrupt",
            "evalue": "Execution interrupted",
            "traceback": tb_lines,
        }
        _send_event({"type": "output", "cellId": cell_id, "output": err_out})
        if role == "check":
            _send_event({
                "type": "check_result",
                "cellId": cell_id,
                "result": {
                    "passed": False,
                    "checkPassed": False,
                    "status": "failed",
                    "summary": "Execution interrupted",
                    "ranAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                },
            })
    except BaseException as exc:
        status = "error"
        tb_lines = _format_traceback(exc, filename)
        err_out = {
            "outputType": "error",
            "ename": type(exc).__name__,
            "evalue": str(exc),
            "traceback": tb_lines,
        }
        _send_event({"type": "output", "cellId": cell_id, "output": err_out})
        if role == "check":
            _send_event({
                "type": "check_result",
                "cellId": cell_id,
                "result": {
                    "passed": False,
                    "checkPassed": False,
                    "status": "failed",
                    "summary": f"{type(exc).__name__}: {exc}",
                    "ranAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                },
            })
    finally:
        if workspace_real:
            _snapshot_workspace_mtimes(workspace_real)
        builtins.__import__ = _orig_import
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        _current_exec_id = None

    duration_ms = max(0, int(round((time.perf_counter() - started) * 1000)))
    _send_event({
        "type": "done",
        "cellId": cell_id,
        "executionCount": exec_count,
        "durationMs": duration_ms,
        "status": status,
        "variables": _collect_vars(),
        "reloadedModules": reloaded_modules,
    })


def main() -> int:
    global _sock
    port_str = os.environ.get("TWIG_KERNEL_PORT", "")
    token = os.environ.get("TWIG_KERNEL_TOKEN", "")
    if not port_str or not token:
        sys.stderr.write("Missing TWIG_KERNEL_PORT or TWIG_KERNEL_TOKEN\n")
        return 2

    port = int(port_str)
    sock = socket.create_connection(("127.0.0.1", port), timeout=10.0)
    sock.settimeout(None)
    _sock = sock
    _send_event({"type": "auth", "token": token})

    cmd_queue: queue.Queue[dict[str, Any] | None] = queue.Queue()

    def _reader_loop() -> None:
        buf = b""
        try:
            while True:
                try:
                    chunk = sock.recv(65536)
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    raw = line.decode("utf-8", errors="replace").strip()
                    if not raw:
                        continue
                    try:
                        cmd = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if cmd.get("type") == "interrupt":
                        if _current_exec_id is not None:
                            _thread.interrupt_main()
                        continue
                    cmd_queue.put(cmd)
        finally:
            cmd_queue.put(None)

    reader = threading.Thread(target=_reader_loop, name="twig-kernel-reader", daemon=True)
    reader.start()

    while True:
        try:
            cmd = cmd_queue.get()
        except KeyboardInterrupt:
            # Stray interrupt while idle: ignore and stay ready.
            continue
        if cmd is None:
            break
        msg_type = cmd.get("type")
        if msg_type == "execute":
            _handle_execute(cmd)
        elif msg_type == "inspect_vars":
            _send_event({
                "type": "vars",
                "requestId": cmd.get("requestId"),
                "variables": _collect_vars(),
            })
        elif msg_type == "ping":
            _send_event({"type": "pong", "requestId": cmd.get("requestId")})
        elif msg_type == "shutdown":
            try:
                sock.close()
            except OSError:
                pass
            return 0
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.default_int_handler)
    raise SystemExit(main())
