"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useShellSound } from "@/lib/useShellSound";
import { useSearchParams } from "next/navigation";
import { BrowserProvider, Contract, JsonRpcProvider, ZeroAddress, ZeroHash } from "ethers";
import { useDecryptPublicValues, useDecryptValues, useGrantPermit, useHasPermit, useShield } from "@zama-fhe/react-sdk";
import { cusdtAbi, erc20Abi } from "@/lib/abi";
import {
  BOX_PRICE,
  CUSDT,
  INVITE_ADDRESS as UPDATED_ADDRESS,
  LEGACY_INVITE_ADDRESS,
  PREVIOUS_INVITE_ADDRESS,
  SEPOLIA_CHAIN_ID_HEX,
  SEPOLIA_RPC_URL,
  UNDERLYING,
  addressUrl,
  explainChainError,
} from "@/lib/config";
import { inviteAbi } from "@/lib/inviteAbi";
import { useWallet } from "@/lib/wallet";

const ShellScene = dynamic(() => import("./ShellScene"), { ssr: false });

const HANDS = 3;
const SLOTS = [0, 1] as const;
type Payment = { funded: bigint; due: bigint; pendingHandle: `0x${string}` };

type InviteView = {
  host: string;
  deadline: number;
  phase: number;
  pot: bigint;
  paymentKind: number;
  payments: Payment[];
  player0: string;
  player1: string;
  winner: string;
  claimed: boolean;
  winnerHandle: string;
  hostHands: number;
  guestHands: number;
  hostCommitted: boolean;
  guestCommitted: boolean;
  ballHandle: string;
};

function short(address: string) {
  if (!address || address === "0x0000000000000000000000000000000000000000") return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function timeLeft(deadline: number, now: number) {
  const left = deadline * 1000 - now;
  if (left <= 0) return "The 48-hour link is closed";
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m left on this link`;
}

export function InviteTable() {
  const params = useSearchParams();
  const invited = params.get("invite") ?? "";
  const requested = params.get("contract") ?? "";
  const legacy = !!invited && !!requested && same(requested, LEGACY_INVITE_ADDRESS);
  const previous = !!invited && !!requested && same(requested, PREVIOUS_INVITE_ADDRESS);
  const INVITE_ADDRESS = (
    legacy
      ? LEGACY_INVITE_ADDRESS
      : previous
        ? PREVIOUS_INVITE_ADDRESS
        : !requested || same(requested, UPDATED_ADDRESS)
          ? UPDATED_ADDRESS
          : ""
  ) as `0x${string}`;
  const [fastContract, setFastContract] = useState("");
  const [failedBatchClaim, setFailedBatchClaim] = useState("");
  const fast = !!INVITE_ADDRESS && same(fastContract, INVITE_ADDRESS);
  const { account, provider: walletProvider } = useWallet();
  const [inviteId, setInviteId] = useState(invited);
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<number | null>(null);
  const [wantBall, setWantBall] = useState(false);
  const { muted, toggleSound, playSound } = useShellSound();
  const heardBall = useRef("");
  const paidResult = useRef<{ id: string; paid: boolean } | null>(null);
  const shield = useShield({ address: CUSDT });
  const publicDecrypt = useDecryptPublicValues();
  const { mutateAsync: grantPermit } = useGrantPermit();
  const { data: hasPermit } = useHasPermit({
    contractAddresses: INVITE_ADDRESS ? [INVITE_ADDRESS] : [],
  });
  const ballReady = !!invite?.ballHandle && !/^0x0{64}$/i.test(invite.ballHandle);
  const ballDecrypt = useDecryptValues(
    ballReady ? [{ encryptedValue: invite.ballHandle as `0x${string}`, contractAddress: INVITE_ADDRESS }] : [],
    { enabled: wantBall && !!hasPermit && ballReady },
  );

  const link = useMemo(() => {
    if (!inviteId || typeof window === "undefined") return "";
    return `${window.location.origin}/play?invite=${inviteId}&contract=${INVITE_ADDRESS}`;
  }, [inviteId, INVITE_ADDRESS]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!invited) return;
    setInviteId(invited);
    const poll = () =>
      void refresh(invited).then(
        () => setReadError(""),
        () => setReadError("Could not refresh this table. Retrying…"),
      );
    poll();
    const timer = window.setInterval(poll, 8_000);
    return () => window.clearInterval(timer);
  }, [invited, account, INVITE_ADDRESS]);

  function reader() {
    return new Contract(
      INVITE_ADDRESS,
      inviteAbi,
      new JsonRpcProvider(SEPOLIA_RPC_URL, 11155111, { staticNetwork: true, cacheTimeout: -1 }),
    );
  }

  useEffect(() => {
    if (!INVITE_ADDRESS || legacy) return;
    let active = true;
    const box = reader();
    const rpc = box.runner!.provider as JsonRpcProvider;
    void box.FAST_FLOW_VERSION().then(
      (version: bigint) => {
        if (active && version === 1n) setFastContract(INVITE_ADDRESS);
      },
      () => {},
    );
    return () => {
      active = false;
      rpc.destroy();
    };
  }, [INVITE_ADDRESS, legacy]);

  async function signer() {
    const ethereum = walletProvider;
    if (!ethereum || (await ethereum.request({ method: "eth_chainId" })) !== SEPOLIA_CHAIN_ID_HEX) {
      throw new Error("Connect a wallet on Sepolia.");
    }
    return new BrowserProvider(ethereum).getSigner(account);
  }

  async function refresh(id = inviteId) {
    if (!INVITE_ADDRESS || !/^[1-9]\d{0,77}$/.test(id) || BigInt(id) >= 1n << 256n) return;
    const box = reader();
    const blockTag = await box.runner!.provider!.getBlockNumber();
    const [snap, seats, hands, committed, payments] = await Promise.all([
      box.getInvite(id, { blockTag }),
      box.getSeats(id, { blockTag }),
      box.getHands(id, { blockTag }),
      box.getCommitted(id, { blockTag }),
      legacy ? [] : Promise.all(SLOTS.map((slot) => box.getPayment(id, slot, { blockTag }))),
    ]);
    if (snap.host === ZeroAddress) {
      setInvite(null);
      setError("This invite link does not match a table.");
      return;
    }
    const mine = same(account, seats.player0) ? 0 : same(account, seats.player1) ? 1 : -1;
    const iPlayed = mine === 0 ? hands.hostHands > 0 : mine === 1 ? hands.guestHands > 0 : false;
    const ballHandle = iPlayed ? ((await box.getBallHandle(id, mine, { blockTag })) as string) : `0x${"0".repeat(64)}`;
    setInvite({
      host: snap.host,
      deadline: Number(snap.deadline),
      phase: Number(snap.phase),
      pot: snap.pot,
      paymentKind: Number(snap.paymentKind),
      payments,
      player0: seats.player0,
      player1: seats.player1,
      winner: snap.winner,
      claimed: snap.claimed,
      winnerHandle: snap.winnerHandle,
      hostHands: Number(hands.hostHands),
      guestHands: Number(hands.guestHands),
      hostCommitted: committed.hostCommitted,
      guestCommitted: committed.guestCommitted,
      ballHandle,
    });
  }

  async function ensureClear() {
    const wallet = await signer();
    const token = new Contract(UNDERLYING, erc20Abi, wallet);
    if ((await token.balanceOf(account)) >= BOX_PRICE) return;
    setStatus("Minting test USDT…");
    await (await token.mint(account, BOX_PRICE)).wait();
  }

  async function payConfidential() {
    await ensureClear();
    setStatus("Shielding $1 into cUSDT…");
    await shield.mutateAsync({ amount: BOX_PRICE });
  }

  function remember(id: string) {
    setInviteId(id);
    const next = `/play?invite=${id}&contract=${INVITE_ADDRESS}`;
    window.history.replaceState(null, "", next);
  }

  async function createTable() {
    setBusy(true);
    setError("");
    try {
      setStatus("Opening the 48-hour link…");
      const box = new Contract(INVITE_ADDRESS, inviteAbi, await signer());
      const receipt = await (await box.createInvite()).wait();
      const id = readInviteId(box, receipt) ?? inviteId;
      remember(id);
      setStatus("Link is open. Play your three hands free, then pay $1 to commit your score.");
      await refresh(id);
    } catch (err) {
      setError(explainChainError(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  async function joinTable() {
    setBusy(true);
    setError("");
    try {
      setStatus("Taking the open seat…");
      const box = new Contract(INVITE_ADDRESS, inviteAbi, await signer());
      await (await box.joinInvite(inviteId)).wait();
      setStatus("Seat taken. Play your three hands free, then pay $1 to commit your score.");
      await refresh();
    } catch (err) {
      setError(explainChainError(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  async function commitConfidential() {
    setBusy(true);
    setError("");
    try {
      const token = new Contract(CUSDT, cusdtAbi, await signer());
      if (!(await token.isOperator(account, INVITE_ADDRESS))) {
        const until = Math.floor(Date.now() / 1000) + 15 * 60;
        await (await token.setOperator(INVITE_ADDRESS, until)).wait();
      }
      setStatus("Paying $1 and committing your score…");
      const box = new Contract(INVITE_ADDRESS, inviteAbi, await signer());
      await (await box.commit(inviteId)).wait();
      setStatus("Stake submitted. Follow the table status below.");
      await refresh();
    } catch (err) {
      setError(`cUSDT stake failed: ${explainChainError(err)}`);
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  async function commitClear() {
    setBusy(true);
    setError("");
    try {
      await ensureClear();
      const wallet = await signer();
      const token = new Contract(UNDERLYING, erc20Abi, wallet);
      if ((await token.allowance(account, INVITE_ADDRESS)) < BOX_PRICE) {
        setStatus("Fallback Payment: approving $1…");
        await (await token.approve(INVITE_ADDRESS, BOX_PRICE)).wait();
      }
      setStatus("Fallback Payment: committing your score…");
      const box = new Contract(INVITE_ADDRESS, inviteAbi, wallet);
      await (await box.commitFallback(inviteId)).wait();
      setStatus("Stake submitted. Follow the table status below.");
      await refresh();
    } catch (err) {
      setError(`Fallback Payment failed: ${explainChainError(err)}`);
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  function startRound() {
    playSound("shuffle", true);
    setChosen(null);
    setWantBall(false);
    setPicking(true);
    setStatus(`Hand ${myHands + 1} of ${HANDS}. Pick a shell.`);
  }

  async function playCup(cup: number) {
    playSound("pick", true);
    setBusy(true);
    setError("");
    setChosen(cup);
    try {
      setStatus("Sealing your hand…");
      const box = new Contract(INVITE_ADDRESS, inviteAbi, await signer());
      let id = inviteId;
      if (fast && !inviteId) {
        const receipt = await (await box.createAndPlay(cup)).wait();
        const openedId = readInviteId(box, receipt);
        if (!openedId) throw new Error("Table opened. Check the transaction for its invite ID.");
        id = openedId;
        remember(id);
      } else if (fast && waiting && !seated) {
        await (await box.joinAndPlay(id, cup)).wait();
      } else {
        await (await box.play(id, cup)).wait();
      }
      setPicking(false);
      await refresh(id);
      if (!hasPermit) {
        setStatus("Sign the permit to see your own cup…");
        await grantPermit([INVITE_ADDRESS]);
      }
      setWantBall(true);
      setPicking(false);
      setStatus("");
    } catch (err) {
      setError(explainChainError(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  async function claim(sendPayout: boolean) {
    if (!invite || /^0x0{64}$/i.test(invite.winnerHandle)) return;
    setBusy(true);
    setError("");
    try {
      setStatus("Proving the winner address. Scores stay encrypted…");
      const revealed = await publicDecrypt.mutateAsync([invite.winnerHandle as `0x${string}`]);
      const box = new Contract(INVITE_ADDRESS, inviteAbi, await signer());
      const submit = sendPayout ? box.claimAndPay : box.claim;
      await (await submit(inviteId, revealed.abiEncodedClearValues, revealed.decryptionProof)).wait();
      setStatus("");
      await refresh();
    } catch (err) {
      if (sendPayout) setFailedBatchClaim(`${INVITE_ADDRESS}:${inviteId}`);
      setError(explainChainError(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  async function settlePayment(slot: number, pendingHandle?: `0x${string}`) {
    setBusy(true);
    setError("");
    try {
      const box = new Contract(INVITE_ADDRESS, inviteAbi, await signer());
      if (pendingHandle && pendingHandle !== ZeroHash) {
        const proof = await publicDecrypt.mutateAsync([pendingHandle]);
        await (await box.confirmTransfer(inviteId, slot, proof.abiEncodedClearValues, proof.decryptionProof)).wait();
      } else {
        await (await box.paySeat(inviteId, slot)).wait();
      }
      setStatus("");
      await refresh();
    } catch (err) {
      setError(explainChainError(err));
    } finally {
      setBusy(false);
    }
  }

  async function refund() {
    setBusy(true);
    setError("");
    try {
      setStatus("Returning the committed stake…");
      const box = new Contract(INVITE_ADDRESS, inviteAbi, await signer());
      await (await box.refundExpired(inviteId)).wait();
      setStatus("");
      await refresh();
    } catch (err) {
      setError(explainChainError(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  const mySlot = invite && same(account, invite.player0) ? 0 : invite && same(account, invite.player1) ? 1 : -1;
  const seated = mySlot >= 0;
  const myHands = mySlot === 0 ? (invite?.hostHands ?? 0) : mySlot === 1 ? (invite?.guestHands ?? 0) : 0;
  const myCommitted = mySlot === 0 ? !!invite?.hostCommitted : mySlot === 1 ? !!invite?.guestCommitted : false;
  const otherCommitted = mySlot === 0 ? !!invite?.guestCommitted : mySlot === 1 ? !!invite?.hostCommitted : false;
  const open = invite?.phase === 1;
  const expired = open && invite.deadline * 1000 <= now;
  const waiting = open && !expired && invite.player1 === "0x0000000000000000000000000000000000000000";
  const sealed = invite?.phase === 2 && !invite.claimed;
  const canStartFast = fast && !!account && ((!invite && !inviteId) || (waiting && !seated));
  const canPlay = !legacy && seated && open && !expired && myHands < HANDS;
  const ownPayment = mySlot < 0 ? undefined : invite?.payments[mySlot];
  const canCommit =
    !legacy &&
    seated &&
    open &&
    !expired &&
    myHands >= HANDS &&
    !myCommitted &&
    (!ownPayment || ownPayment.pendingHandle === ZeroHash);
  const myBall = ballReady ? Number(ballDecrypt.data?.[invite.ballHandle as `0x${string}`]) : NaN;
  const ballKnown = wantBall && Number.isInteger(myBall);
  useEffect(() => {
    if (!ballKnown || !invite || myBall > 2 || heardBall.current === invite.ballHandle) return;
    heardBall.current = invite.ballHandle;
    playSound(myBall === chosen ? "hit" : "reveal");
  }, [ballKnown, invite, myBall, chosen, playSound]);

  useEffect(() => {
    if (!invite || legacy || !account) return;
    const id = `${INVITE_ADDRESS}:${inviteId}:${account}`;
    const previous = paidResult.current;
    paidResult.current = { id, paid: invite.claimed };
    if (previous?.id === id && !previous.paid && invite.claimed && same(account, invite.winner)) playSound("win");
  }, [account, invite, inviteId, legacy, INVITE_ADDRESS, playSound]);

  return (
    <main className="table-room">
      <header className="marquee">
        <h1>Shell Table</h1>
        <p>Two players. Three picks each.</p>
      </header>
      <div className="felt-wrap">
        <div className="felt">
          <ShellScene picking={picking} revealed={ballKnown ? myBall : -1} />
          <div className="table-rail">
            <span>{invite ? `Table ${inviteId}` : "Sepolia testnet"}</span>
            <button className="sound-toggle" type="button" aria-pressed={!muted} onClick={toggleSound}>
              Sound {muted ? "off" : "on"}
            </button>
          </div>
          <div className={`cups ${picking ? "picking" : ""}`}>
            {[0, 1, 2].map((cup) => (
              <button
                key={cup}
                type="button"
                className={`cup ${ballKnown && myBall === cup ? "lift" : ""} ${chosen === cup ? "chosen" : ""}`}
                aria-label={`Cup ${cup + 1}`}
                disabled={(!canPlay && !canStartFast) || !picking || busy}
                onClick={() => void playCup(cup)}
              >
                <span className="cup-object" aria-hidden="true" />
                <span className={`ball ${ballKnown && myBall === cup ? "show" : ""}`} aria-hidden="true" />
                <span className="cup-index" aria-hidden="true">
                  {cup + 1}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className={`table-msg ${error ? "bad" : "info"}`}>
        {error ||
          readError ||
          status ||
          (ballKnown
            ? myBall === 3
              ? "Draw void. Both stakes are returned at settlement."
              : chosen !== null && myBall === chosen
                ? "The ball was under the cup you picked. Your score stays encrypted."
                : chosen !== null
                  ? "The ball was under a different cup. Your score stays encrypted."
                  : "Your cup is revealed. Your score stays encrypted."
            : "Play your three hands free. The other player does not have to be here.")}
      </p>
      <div className="table-controls">
        {canStartFast && !picking && (
          <button type="button" disabled={busy} onClick={startRound}>
            {invite ? "Join and play hand 1" : "Open and play hand 1"}
          </button>
        )}
        {!invite && !(canStartFast && picking) && (
          <button
            type="button"
            className={fast ? "ghost" : undefined}
            disabled={!account || !INVITE_ADDRESS || busy}
            onClick={() => void createTable()}
          >
            {fast ? "Open without playing" : "Open a table"}
          </button>
        )}
        {!legacy && waiting && !seated && !fast && (
          <button type="button" disabled={!account || busy} onClick={() => void joinTable()}>
            Take the open seat
          </button>
        )}
        {canPlay && !picking && (
          <button type="button" disabled={busy} onClick={startRound}>
            Play hand {myHands + 1} of {HANDS}
          </button>
        )}
        {canCommit && invite?.paymentKind !== 2 && (
          <button type="button" disabled={!account || busy} onClick={() => void commitConfidential()}>
            Stake cUSDT test token
          </button>
        )}
        {canCommit && invite?.paymentKind !== 2 && (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void payConfidential()
                .then(() => setStatus("Test tokens ready."))
                .catch((err) => setError(explainChainError(err)))
                .finally(() => setBusy(false));
            }}
          >
            Get cUSDT test tokens
          </button>
        )}
        {myCommitted && open && !otherCommitted && (
          <span className="fast-badge">Score committed. The other player commits to resolve.</span>
        )}
        {sealed && (
          <button type="button" disabled={!account || busy} onClick={() => void claim(fast)}>
            {legacy ? "Submit original prize claim" : fast ? "Verify result and send payout" : "Verify match result"}
          </button>
        )}
        {sealed && fast && failedBatchClaim === `${INVITE_ADDRESS}:${inviteId}` && (
          <button type="button" className="ghost" disabled={!account || busy} onClick={() => void claim(false)}>
            Verify result separately
          </button>
        )}
        {expired && invite.payments.every((payment) => payment.pendingHandle === ZeroHash) && (
          <button type="button" disabled={!account || busy} onClick={() => void refund()}>
            Refund the committed stake
          </button>
        )}
        {canCommit && invite?.paymentKind !== 1 && (
          <button type="button" className="ghost" disabled={!account || busy} onClick={() => void commitClear()}>
            Stake clear test token
          </button>
        )}
      </div>
      {invite && !legacy && (
        <div className="table-controls">
          {invite.payments.map((payment, slot) => {
            const pending = payment.pendingHandle !== ZeroHash;
            if (open && !pending) return null;
            if (!open && payment.due === 0n) return null;
            return (
              <button
                key={slot}
                type="button"
                disabled={!account || busy}
                onClick={() => void settlePayment(slot, payment.pendingHandle)}
              >
                {pending ? "Confirm" : "Send"} seat {slot + 1} {open ? "stake" : "payout"}
              </button>
            );
          })}
        </div>
      )}
      {!INVITE_ADDRESS && <p className="seat-line">Set the updated Sepolia contract address to open new tables.</p>}
      {link && invite && (
        <div className="invite-link">
          <span>Invitation link</span>
          <code>{link}</code>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(
                () => setCopied(true),
                () => setError("Copy the invitation URL from your address bar."),
              );
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          {open && <p>{timeLeft(invite.deadline, now)}</p>}
        </div>
      )}
      {invite?.claimed && (
        <p className="table-msg good">
          {legacy
            ? "Original claim recorded. Check the transfer on Sepolia."
            : invite.winner === ZeroAddress
              ? "Any funded stakes were returned."
              : same(account, invite.winner)
                ? "You won. The prize was paid."
                : `Prize paid to ${short(invite.winner)}.`}
        </p>
      )}
      {invite && (
        <p className="seat-line">
          Seat 1 {short(invite.player0) || "open"}
          {" · "}
          Seat 2 {short(invite.player1) || "open"}
          {invite.host && (
            <>
              {" · "}
              <a href={addressUrl(INVITE_ADDRESS)}>Contract</a>
            </>
          )}
        </p>
      )}
      {!INVITE_ADDRESS && <p className="table-msg bad">The invite contract is not on Sepolia yet.</p>}
      {!account && (
        <p className="table-msg info">Connect a wallet on Sepolia. The other player can open the link later.</p>
      )}
      <p className="seat-line">
        <Link href="/showdown">2–5 player showdown</Link>
      </p>
    </main>
  );
}

function readInviteId(box: Contract, receipt: { logs: Array<{ topics: string[]; data: string }> }) {
  const parsed = receipt.logs
    .map((log) => {
      try {
        return box.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((item) => item?.name === "InviteCreated");
  return (parsed?.args?.inviteId as bigint | undefined)?.toString();
}
