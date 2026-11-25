import { discoverPythonEnvs, getChat, readSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	const url = new URL(req.url);
	const chatId = url.searchParams.get("chatId");
	const refresh = url.searchParams.get("refresh") === "1";

	const workspaceDir = chatId ? getChat(chatId)?.lab?.workspaceDir : undefined;
	const configuredPythonPath = readSettingsRecord()?.lab?.pythonPath;
	const envs = await discoverPythonEnvs({ workspaceDir, configuredPythonPath, refresh });
	return Response.json({ envs });
}
