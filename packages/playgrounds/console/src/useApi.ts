import { useEffect, useState } from "react";

import { apiFetch } from "./client";

type ApiState<T> = { data?: T; error?: string; loading: boolean };

export const useApi = <T>(path: string, pollMs?: number): ApiState<T> => {
  const [state, setState] = useState<ApiState<T>>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      apiFetch<T>(path)
        .then((data) => !cancelled && setState({ data, loading: false }))
        .catch(
          (error) => !cancelled && setState({ error: (error as Error).message, loading: false }),
        );
    load();
    const interval = pollMs ? setInterval(load, pollMs) : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [path, pollMs]);

  return state;
};
