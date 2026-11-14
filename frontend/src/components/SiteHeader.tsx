import Link from "next/link";
import { WalletButton } from "@/lib/wallet";

export function SiteHeader() {
  return (
    <header className="site wrap">
      <Link href="/" className="brand">
        <img src="/logo.svg" alt="Provable Mystery Box logo" />
        Shell Table
      </Link>
      <nav>
        <Link href="/showdown">Showdown</Link>
        <WalletButton />
      </nav>
    </header>
  );
}
