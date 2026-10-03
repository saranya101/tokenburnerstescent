"use client";

import type { BankStateSnapshotV1, CustomerActivityV1 } from "@parlance/contracts";
import { useCallback, useEffect, useState } from "react";
import { createParlanceApi, ParlanceApiError } from "../lib/parlance-api";

export function useBankingState() {
  const [state, setState] = useState<BankStateSnapshotV1>();
  const [activity, setActivity] = useState<CustomerActivityV1>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const api = createParlanceApi(); const [nextState, nextActivity] = await Promise.all([api.customerState(), api.customerActivity()]);
      setState(nextState); setActivity(nextActivity);
    }
    catch (reason) { setError(reason instanceof ParlanceApiError ? reason.code : "CUSTOMER_STATE_UNAVAILABLE"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { state, activity, loading, error, refresh };
}
