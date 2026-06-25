import { handleRouteError, jsonResponse, requireMethod } from "../server/http.server"
import { readWorkspaceTree } from "../server/workspaces.server"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    const url = new URL(request.url)
    return jsonResponse(await readWorkspaceTree(url.searchParams.get("path"), url.searchParams.get("hidden") === "1"))
  } catch (error) {
    return handleRouteError(error)
  }
}
