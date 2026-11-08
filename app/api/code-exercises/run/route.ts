import { CodeExerciseUnavailableError, parseCppRunBody, runCpp } from "@/src/server";

/**
 * POST /api/code-exercises/run — the local C++ compiler for code exercises.
 * The browser owns Python/JavaScript/TypeScript; this route exists only for
 * C++ and refuses every other language. Compile errors are returned as run
 * results (200); a missing compiler is a 503 so the dock can say the runtime
 * is unavailable.
 */

export const dynamic = "force-dynamic";

/** A hard ceiling before JSON parsing; the seam itself caps code + tests. */
const MAX_BODY_BYTES = 1_000_000;

export async function POST(request: Request): Promise<Response> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		return Response.json({ error: "The request body is too large." }, { status: 413 });
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Expected a JSON body." }, { status: 400 });
	}
	const parsed = parseCppRunBody(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	try {
		return Response.json(await runCpp(parsed.request));
	} catch (error) {
		if (error instanceof CodeExerciseUnavailableError) {
			return Response.json({ error: error.message, unavailable: true }, { status: 503 });
		}
		return Response.json(
			{ error: error instanceof Error ? error.message : "The C++ runner failed." },
			{ status: 500 },
		);
	}
}
