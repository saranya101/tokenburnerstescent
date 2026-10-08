import { NextRequest, NextResponse } from "next/server";
import { createOperatorSession, OPERATOR_SESSION_COOKIE, OPERATOR_SESSION_MAX_AGE_SECONDS, sameOriginMutation } from "../../../../lib/server-api-auth";

const cookieOptions = { httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production", path: "/" };

export async function POST(request: NextRequest) {
  if (!sameOriginMutation(request)) return NextResponse.json({ code: "REQUEST_NOT_AUTHORIZED" }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 }); }
  const token = body && typeof body === "object" && "accessToken" in body && typeof body.accessToken === "string" ? body.accessToken : "";
  const session = createOperatorSession(token);
  if (!session) return NextResponse.json({ code: "REQUEST_NOT_AUTHORIZED" }, { status: 401 });
  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(OPERATOR_SESSION_COOKIE, session, { ...cookieOptions, maxAge: OPERATOR_SESSION_MAX_AGE_SECONDS });
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!sameOriginMutation(request)) return NextResponse.json({ code: "REQUEST_NOT_AUTHORIZED" }, { status: 403 });
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(OPERATOR_SESSION_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  return response;
}
