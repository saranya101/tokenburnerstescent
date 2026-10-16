import { NextResponse } from "next/server";
export async function GET() { return NextResponse.json({ code: "PROVIDER_LOGIN_REMOVED" }, { status: 410 }); }
