import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ status: "ok", mode: process.env.PARLANCE_PUBLIC_SAFE_MODE === "true" ? "interface-preview" : "application" }, { headers: { "cache-control": "no-store" } });
}
