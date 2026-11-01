import { useEffect, useState } from "react";
import { isPhoneTier } from "./phoneTier.ts";

/** Same phone tier as the dashboard. */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(isPhoneTier);
  useEffect(() => {
    const update = () => setPhone(isPhoneTier());
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
