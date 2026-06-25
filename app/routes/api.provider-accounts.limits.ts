import { readConnectedAccountLimits } from "../server/accounts.service"
import { handleRouteError, jsonResponse, requireMethod } from "../server/http.server"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    return jsonResponse(await readConnectedAccountLimits())
  } catch (error) {
    return handleRouteError(error)
  }
}
