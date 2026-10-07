/**
 * dsh-helloai-works — the toast, shared by the panel and the card tab.
 *
 * A notice carrying actions is a decision the user has to make: a save conflict
 * (marked `follows`, so it also appears in the card column) or a confirmation
 * before something irreversible. Each carries its own buttons, so an actionable
 * notice has no dismiss control of its own — a confirmation offers "cancel"
 * instead, and dismissing a conflict would strand its unsaved edits with nowhere
 * to go. Plain status toasts stay on the panel.
 */
import * as React from "react";
import { worksStore } from "./works-store.js";
import type { Notice } from "./works-store.js";

export function NoticeBar({ notice }: { notice: Notice }) {
  const actions = notice.actions ?? [];
  return (
    <div className={`hxw-notice hxw-notice-${notice.kind}`} role="status">
      <style>{NOTICE_CSS}</style>
      <span className="hxw-notice-text">{notice.text}</span>
      {actions.length ? (
        <span className="hxw-notice-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`hxw-notice-btn${action.tone === "primary" ? " hxw-notice-primary" : action.tone === "danger" ? " hxw-notice-danger" : ""}`}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </span>
      ) : (
        <button type="button" className="hxw-notice-close" onClick={() => worksStore.setNotice(null)}>
          ✕
        </button>
      )}
    </div>
  );
}

const NOTICE_CSS = `
.hxw-notice{--hxw-accent:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));--hxw-border-2:var(--dsw-alias-border-l2);--hxw-card:var(--dsw-alias-bg-layer-1);--hxw-text-3:var(--dsw-alias-label-tertiary);--hxw-danger:var(--dsw-alias-state-error-primary,#dc2626);position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:40;display:flex;align-items:center;gap:12px;max-width:min(780px,92%);border:1px solid var(--hxw-border-2);border-radius:10px;background:var(--dsw-alias-bg-overlay,var(--hxw-card));padding:9px 12px;box-shadow:0 8px 24px rgb(0 0 0 / 18%);font-size:13px;line-height:1.5}
.hxw-notice-text{flex:1;min-width:0}
.hxw-notice-actions{display:flex;gap:6px;flex:none;flex-wrap:wrap}
.hxw-notice button{font:inherit;cursor:pointer}
.hxw-notice-btn{border:1px solid var(--hxw-border-2);border-radius:7px;background:0 0;color:inherit;padding:3px 9px;font-size:12px;white-space:nowrap}
.hxw-notice-btn:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
.hxw-notice-primary{border-color:var(--hxw-accent);color:var(--hxw-accent);font-weight:600}
.hxw-notice-danger{border-color:color-mix(in srgb,var(--hxw-danger) 55%,var(--hxw-border-2));color:var(--hxw-danger);font-weight:600}
.hxw-notice-close{border:0;background:0 0;color:var(--hxw-text-3);padding:0 2px}
.hxw-notice-success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 45%,var(--hxw-border-2))}
.hxw-notice-error{border-color:color-mix(in srgb,var(--hxw-danger) 45%,var(--hxw-border-2))}
`;
