import {
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/** Keep menus out of scrolling cards, but inside their modal's focus boundary. */
export function DropdownPopup({
  anchor,
  children,
  onDismiss,
  minWidth = 0,
  preferredHeight = 200,
}: {
  anchor: RefObject<HTMLElement | null>;
  children: ReactNode;
  onDismiss: () => void;
  minWidth?: number;
  preferredHeight?: number;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: 320,
  });
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const up = below < preferredHeight && above > below;
      const maxHeight = Math.max(44, Math.min(320, up ? above : below));
      const height = Math.min(
        popup.current?.scrollHeight ?? maxHeight,
        maxHeight,
      );
      const width = Math.min(
        Math.max(rect.width, minWidth),
        window.innerWidth - 16,
      );
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: up ? rect.top - height - 6 : rect.bottom + 6,
        width,
        maxHeight,
      });
    };
    const dismissOutside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target) &&
        !popup.current?.contains(event.target)
      )
        onDismiss();
    };
    place();
    const observer = new ResizeObserver(place);
    if (anchor.current) observer.observe(anchor.current);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [anchor, onDismiss, minWidth, preferredHeight]);
  return createPortal(
    <div ref={popup} className="dropdown-menu dropdown-popup" style={position}>
      {children}
    </div>,
    anchor.current?.closest("dialog") ?? document.body,
  );
}
