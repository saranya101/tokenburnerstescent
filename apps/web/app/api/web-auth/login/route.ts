import { NextRequest, NextResponse } from "next/server";
import { passwordAuthResponse } from "../../../../lib/password-auth-route";
export async function GET(request: NextRequest) { return NextResponse.redirect(new URL("/", request.url)); }
export function POST(request: NextRequest) { return passwordAuthResponse(request, "login", true); }
