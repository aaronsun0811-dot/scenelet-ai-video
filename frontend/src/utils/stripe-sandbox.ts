const STRIPE_SANDBOX_ASSIST_KEY = "arcreel.stripeSandboxAssist";
const STRIPE_SANDBOX_ASSIST_EVENT = "arcreel:stripe-sandbox-assist";

export function getStripeSandboxAssist(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STRIPE_SANDBOX_ASSIST_KEY) === "1";
}

export function setStripeSandboxAssist(enabled: boolean) {
  if (typeof window === "undefined") return;
  if (enabled) {
    window.localStorage.setItem(STRIPE_SANDBOX_ASSIST_KEY, "1");
  } else {
    window.localStorage.removeItem(STRIPE_SANDBOX_ASSIST_KEY);
  }
  window.dispatchEvent(
    new CustomEvent(STRIPE_SANDBOX_ASSIST_EVENT, { detail: enabled }),
  );
}

export function onStripeSandboxAssistChange(callback: (enabled: boolean) => void) {
  if (typeof window === "undefined") return () => {};

  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<boolean>).detail;
    callback(Boolean(detail));
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STRIPE_SANDBOX_ASSIST_KEY) {
      callback(getStripeSandboxAssist());
    }
  };

  window.addEventListener(STRIPE_SANDBOX_ASSIST_EVENT, handleCustom);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(STRIPE_SANDBOX_ASSIST_EVENT, handleCustom);
    window.removeEventListener("storage", handleStorage);
  };
}
