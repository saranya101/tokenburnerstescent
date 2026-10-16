import { NextRequest } from "next/server";
import { passwordAuthResponse } from "../../../../lib/password-auth-route";
export function POST(request: NextRequest) { return passwordAuthResponse(request, "signup", true); }
