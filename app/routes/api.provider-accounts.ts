import type { CreateProviderAccountRequest } from "../types/providers"
import { createAccount, listAccounts } from "../server/accounts.service"
import {
  handleRouteError,
  jsonResponse,
  readJsonBody,
  readRecordField,
  readStringField,
  requireMethod,
} from "../server/http.server"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    return jsonResponse(await listAccounts())
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request }: { request: Request }) {
  try {
    requireMethod(request, ["POST"])
    const body = await readJsonBody<CreateProviderAccountRequest>(request)
    return jsonResponse(
      await createAccount({
        displayName: readStringField(body.displayName, "displayName", { maxLength: 100 }),
        providerId: readStringField(body.providerId, "providerId", { required: true }),
        runtimeDefaults: readRecordField(body.runtimeDefaults, "runtimeDefaults") as CreateProviderAccountRequest["runtimeDefaults"],
        settings: readRecordField(body.settings, "settings") as CreateProviderAccountRequest["settings"],
      }),
      { status: 201 },
    )
  } catch (error) {
    return handleRouteError(error)
  }
}
