"use client";

import type { BankStateSnapshotV1 } from "@parlance/contracts";
import { useCallback, useEffect, useState } from "react";
import { createParlanceApi, ParlanceApiError } from "../lib/parlance-api";

export function useBankingState() {
  const [state, setState] = useState<BankStateSnapshotV1>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    setLoading(true); setError(undefined);
    try { setState(await createParlanceApi().customerState()); }
    catch (reason) { setError(reason instanceof ParlanceApiError ? reason.code : "CUSTOMER_STATE_UNAVAILABLE"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { state, loading, error, refresh };
}
