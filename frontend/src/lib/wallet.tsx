"use client";

import {
  ConnectButton,
  connectorsForWallets,
  darkTheme,
  RainbowKitProvider,
  useConnectModal,
} from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createConfig, http, useAccount, WagmiProvider } from "wagmi";
import { sepolia } from "wagmi/chains";
import { explainChainError, SEPOLIA_RPC_URL } from "@/lib/config";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
const config = createConfig({
  chains: [sepolia],
  connectors: connectorsForWallets(
    [{
      groupName: "Wallets",
      wallets: projectId
        ? [rainbowWallet, metaMaskWallet, rabbyWallet, walletConnectWallet, injectedWallet]
        : [injectedWallet],
    }],
    { appName: "Shell Table", projectId: projectId ?? "" },
  ),
  transports: { [sepolia.id]: http(SEPOLIA_RPC_URL) },
  ssr: true,
});

const theme = darkTheme({ accentColor: "#e8c58b", accentColorForeground: "#111514", borderRadius: "medium" });

type Connector = NonNullable<ReturnType<typeof useAccount>["connector"]>;
type Wallet = { account: string; provider?: EthereumProvider; connect: () => void; error: string };
const WalletContext = createContext<Wallet | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider initialChain={sepolia} theme={theme}>
          <WalletConnection>{children}</WalletConnection>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function WalletConnection({ children }: { children: ReactNode }) {
  const { address, connector, isConnected, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [connection, setConnection] = useState<{ connector: Connector; provider: EthereumProvider }>();
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    setError("");
    setConnection(undefined);
    if (isConnected && connector) {
      void connector.getProvider().then(
        (provider) => {
          if (current && provider) setConnection({ connector, provider: provider as EthereumProvider });
        },
        (cause: unknown) => {
          if (current) setError(explainChainError(cause));
        },
      );
    }
    return () => { current = false; };
  }, [connector, isConnected]);

  const provider = isConnected && connection?.connector === connector && chainId === sepolia.id
    ? connection?.provider
    : undefined;

  return (
    <WalletContext.Provider
      value={{ account: provider ? address ?? "" : "", provider, connect: () => openConnectModal?.(), error }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("WalletProvider is missing.");
  return wallet;
}

export function WalletButton() {
  const { error } = useWallet();
  return (
    <div className="wallet-slot">
      <ConnectButton label="Connect wallet" accountStatus="address" chainStatus="none" showBalance={false} />
      {error && <span className="wallet-error" role="alert">{error}</span>}
    </div>
  );
}
