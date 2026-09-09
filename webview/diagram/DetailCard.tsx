/**
 * The hover detail for a node and its rows.
 *
 * A node row shows an abbreviation of what the model knows - a name, a
 * type, `PK`. Everything else it knows (the full flag list, the note, what a
 * relation does on delete, which file and line it comes from) is here, one
 * hover away, so the diagram can stay readable without the detail being
 * lost.
 *
 * Presentation only: it renders what it is handed and never reaches into the
 * store, so a table row, a field row and a future view can all use it.
 *
 * The browser editor builds this out of Mantine's `HoverCard`. Here it is
 * hand-rolled against VSCode's own theme variables - a UI library would be a
 * megabyte of bundle and a second design language inside an editor that
 * already has one. The behaviour that matters is kept exactly: an open delay
 * so a card does not flash while the pointer crosses the canvas, and
 * `pointer-events: none`, without which a card left open over a node
 * swallows the mousedown that starts a drag.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";

import type { DetailCardProps } from "./types";

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 80;
const CARD_WIDTH = 320;
const OFFSET = 12;

export function DetailCard({
  title,
  subtitle,
  badges = [],
  facts = [],
  note,
  source,
  children,
}: DetailCardProps): JSX.Element {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const open = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const box = anchor.current?.getBoundingClientRect();
      if (!box) return;
      // Right of the row, flipped to its left when there is no room - the
      // card must not push the canvas or leave the viewport.
      const fitsRight = box.right + OFFSET + CARD_WIDTH <= window.innerWidth;
      setAt({
        top: Math.min(box.top, window.innerHeight - 40),
        left: fitsRight ? box.right + OFFSET : Math.max(8, box.left - OFFSET - CARD_WIDTH),
      });
    }, OPEN_DELAY_MS);
  }, []);

  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAt(null), CLOSE_DELAY_MS);
  }, []);

  return (
    <>
      <span
        ref={anchor}
        className="detail-anchor"
        onMouseEnter={open}
        onMouseLeave={close}
        // A drag starting under an open card would otherwise leave it behind.
        onMouseDown={() => {
          window.clearTimeout(timer.current);
          setAt(null);
        }}
      >
        {children}
      </span>

      {at
        ? createPortal(
            <div className="detail-card" style={{ top: at.top, left: at.left, width: CARD_WIDTH }}>
              <div className="detail-card__head">
                <span className="detail-card__title">{title}</span>
                {subtitle ? <span className="detail-card__subtitle">{subtitle}</span> : null}
              </div>

              {badges.length > 0 ? (
                <div className="detail-card__badges">
                  {badges.map((badge) => (
                    <span key={badge} className="detail-card__badge">
                      {badge}
                    </span>
                  ))}
                </div>
              ) : null}

              {facts.length > 0 ? (
                <dl className="detail-card__facts">
                  {facts.map((fact) => (
                    <div key={fact.label} className="detail-card__fact">
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {note ? <p className="detail-card__note">{note}</p> : null}

              {source ? (
                <p className="detail-card__source">{source} · double-click to open</p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
