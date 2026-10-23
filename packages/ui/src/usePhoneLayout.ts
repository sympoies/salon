import { useEffect, useState } from "react";

function phoneLayout(): boolean {
  return typeof window !== "undefined" && (window.innerWidth <= 760
    || (window.innerWidth <= 1024 && (window.matchMedia?.("(pointer: coarse)").matches ?? false)));
}
/** Same phone tier as the dashboard, including narrow web and touch tablets. */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(phoneLayout);
  useEffect(() => {
    const update = () => setPhone(phoneLayout());
    const pointer = window.matchMedia?.("(pointer: coarse)");
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    pointer?.addEventListener("change", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      pointer?.removeEventListener("change", update);
    };
  }, []);
  return phone;
}
