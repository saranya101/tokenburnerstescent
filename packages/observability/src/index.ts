import { randomUUID } from "node:crypto";
import pino from "pino";
export const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { service: process.env.SERVICE_NAME ?? "parlance" } });
export function resolveTraceId(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && candidate.length <= 128 ? candidate : randomUUID();
}
export async function initializeTelemetry(): Promise<void> {
  // TODO: initialize OpenTelemetry SDK/exporters once deployment topology is known.
  logger.info({ otlpEndpointConfigured: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) }, "telemetry bootstrap placeholder");
}
