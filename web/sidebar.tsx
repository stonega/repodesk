import { type ReactNode, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { IconButton } from "./icon-button.tsx";
import { Modal } from "./modal.tsx";

/** Keep a single navigation tree, using the shared modal focus boundary on mobile. */
export function Sidebar({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 800px)").matches,
  );
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    const changed = () => {
      setMobile(query.matches);
      setOpen(false);
    };
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    void location.key;
    void enabled;
    setOpen(false);
  }, [location.key, enabled]);
  if (!enabled || !mobile) return <aside>{children}</aside>;
  return (
    <>
      <header className="mobile-header">
        <IconButton
          icon="menu"
          label="Open navigation"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        />
        <span className="mobile-brand">RepoDesk</span>
      </header>
      {open && (
        <Modal
          title="Navigation"
          presentation="sheet"
          onClose={() => setOpen(false)}
        >
          <aside>{children}</aside>
        </Modal>
      )}
    </>
  );
}
