"use client";

// 全局 Error Boundary：页面级崩溃不拖垮整个 shell。
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[studio-ui] page error boundary:", error);
  }, [error]);

  return (
    <div className="studio-ui mx-auto mt-16 max-w-lg rounded-[8px] border border-danger/30 bg-danger/8 p-6 text-center">
      <p className="text-[14px] font-semibold text-danger">页面渲染出错</p>
      <p className="mt-2 break-all text-xs text-muted-foreground data-mono">{error.message || "unknown error"}</p>
      {error.digest ? <p className="mt-1 text-[11px] text-subtle-foreground data-mono">digest: {error.digest}</p> : null}
      <button
        type="button"
        onClick={reset}
        className="mt-4 inline-flex h-8 items-center rounded-[6px] bg-primary px-3 text-[13px] font-medium text-primary-foreground anim-120 hover:bg-primary/85"
      >
        重试
      </button>
    </div>
  );
}
