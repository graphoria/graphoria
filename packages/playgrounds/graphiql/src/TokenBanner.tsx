import { useEffect, useRef, useState } from "react";
import { subscribe } from "./auth";

function TokenBanner() {
  const [message, setMessage] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = subscribe((next) => {
      setMessage(next);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setMessage(null), 3000);
    });
    return () => {
      unsubscribe();
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  if (!message) return null;
  return (
    <div className="token-banner" key={message}>
      {message}
    </div>
  );
}

export default TokenBanner;
