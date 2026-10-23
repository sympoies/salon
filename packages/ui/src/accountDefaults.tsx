import { createContext, useContext, type ReactNode } from "react";
import type { AccountProvider } from "@agent-console/shared/api";

export interface DefaultAccountState {
  readonly label?: string;
  readonly defaultName?: string;
  readonly loadedDefaultCopy?: string;
  readonly defaultUsageLabel?: string;
  readonly switchLabels?: { readonly current: (account: string) => string; readonly switching: (account: string) => string; readonly set: (account: string) => string };
  readonly activeAccount: string | null;
  readonly accounts: readonly string[];
  readonly reachable: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly pendingAccount: string | null;
  readonly switchAccount: (account: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
}

export const EMPTY_ACCOUNT_DEFAULT: DefaultAccountState = {
  activeAccount: null,
  accounts: [],
  reachable: false,
  loaded: false,
  error: null,
  pendingAccount: null,
  switchAccount: async () => {},
  refresh: async () => {},
};


export type AccountDefaults = Readonly<Record<AccountProvider, DefaultAccountState>>;
const Context = createContext<AccountDefaults>({ codex: EMPTY_ACCOUNT_DEFAULT, claude: EMPTY_ACCOUNT_DEFAULT });
export function AccountDefaultsProvider({ value, children }: { readonly value: AccountDefaults; readonly children?: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAccountDefaults(): AccountDefaults { return useContext(Context); }
