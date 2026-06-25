import { handleRouteError, jsonResponse, requireMethod } from "../server/http.server"
import { listProviders } from "../server/providers.service"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    return jsonResponse(await listProviders())
  } catch (error) {
    return handleRouteError(error)
  }
}
