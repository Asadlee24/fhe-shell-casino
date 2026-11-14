"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
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
import { TableWalletConnect, useWallet } from "@/lib/wallet";

const ShellScene = dynamic(() => import("./ShellScene"), { ssr: false });

const tableRpc = new JsonRpcProvider(SEPOLIA_RPC_URL, 11155111, { staticNetwork: true });
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
  const [showScene, setShowScene] = useState(false);
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

  const pollTable = useEffectEvent(async (id: string, active: () => boolean) => {
    try {
      await refresh(id, active);
      if (active()) setReadError("");
    } catch {
      if (active()) setReadError("Could not refresh this table. Retrying…");
    }
  });

  useEffect(() => {
    if (!invited || !INVITE_ADDRESS) return;
    setInviteId(invited);
    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (cancelled || running || document.hidden) return;
      running = true;
      await pollTable(invited, () => !cancelled);
      running = false;
      if (!cancelled && !document.hidden) timer = setTimeout(poll, 8_000);
    }

    function onVisibilityChange() {
      clearTimeout(timer);
      if (!document.hidden) void poll();
    }

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [invited, account, INVITE_ADDRESS]);

  const boxReader = useMemo(
    () => (INVITE_ADDRESS ? new Contract(INVITE_ADDRESS, inviteAbi, tableRpc) : null),
    [INVITE_ADDRESS],
  );

  useEffect(() => {
    if (!boxReader || legacy || same(INVITE_ADDRESS, PREVIOUS_INVITE_ADDRESS)) return;
    let active = true;
    void boxReader.FAST_FLOW_VERSION().then(
      (version: bigint) => {
        if (active && version === 1n) setFastContract(INVITE_ADDRESS);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [boxReader, INVITE_ADDRESS, legacy]);

  async function signer() {
    const ethereum = walletProvider;
    if (!ethereum || (await ethereum.request({ method: "eth_chainId" })) !== SEPOLIA_CHAIN_ID_HEX) {
      throw new Error("Connect a wallet on Sepolia.");
    }
    return new BrowserProvider(ethereum).getSigner(account);
  }

  const lastApplied = useRef(0);
  const refreshSequence = useRef(0);

  async function refresh(id = inviteId, active = () => true) {
    if (!boxReader || !/^[1-9]\d{0,77}$/.test(id) || BigInt(id) >= 1n << 256n) return;
    const sequence = ++refreshSequence.current;
    const box = boxReader;
    const blockTag = await tableRpc.getBlockNumber();
    const [snap, seats, hands, committed, payments] = await Promise.all([
      box.getInvite(id, { blockTag }),
      box.getSeats(id, { blockTag }),
      box.getHands(id, { blockTag }),
      box.getCommitted(id, { blockTag }),
      legacy ? [] : Promise.all(SLOTS.map((slot) => box.getPayment(id, slot, { blockTag }))),
    ]);
    if (!active() || sequence < lastApplied.current) return;
    if (snap.host === ZeroAddress) {
      lastApplied.current = sequence;
      setInvite(null);
      setError("This invite link does not match a table.");
      return;
    }
    const mine = same(account, seats.player0) ? 0 : same(account, seats.player1) ? 1 : -1;
    const iPlayed = mine === 0 ? hands.hostHands > 0 : mine === 1 ? hands.guestHands > 0 : false;
    const ballHandle = iPlayed ? ((await box.getBallHandle(id, mine, { blockTag })) as string) : `0x${"0".repeat(64)}`;
    if (!active() || sequence < lastApplied.current) return;
    lastApplied.current = sequence;
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
    setShowScene(true);
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
    setStatus(pendingHandle && pendingHandle !== ZeroHash ? "Checking the transfer with Zama…" : "Sending payout…");
    try {
      const box = new Contract(INVITE_ADDRESS, inviteAbi, await signer());
      if (pendingHandle && pendingHandle !== ZeroHash) {
        const proof = await publicDecrypt.mutateAsync([pendingHandle]);
        setStatus("Confirm the transfer proof in your wallet…");
        await (await box.confirmTransfer(inviteId, slot, proof.abiEncodedClearValues, proof.decryptionProof)).wait();
        if (open && proof.clearValues[pendingHandle] === 0n) {
          setStatus("0 cUSDT transferred. Top up the staking wallet, then try again.");
          await refresh();
          return;
        }
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

  const pendingStake = open && invite.payments.some((payment) => payment.pendingHandle !== ZeroHash);
  const settlementPending =
    !!invite && !open && !sealed && !invite.claimed && invite.payments.some((payment) => payment.due > 0n);
  const hasWinner = !!invite && (invite.phase === 4 || invite.claimed) && invite.winner !== ZeroAddress;
  const winnerSeat = hasWinner && same(invite.winner, invite.player0) ? "Host" : "Guest";
  const won = hasWinner && same(account, invite.winner);
  const resultTitle = hasWinner
    ? won
      ? "You won"
      : `${winnerSeat} wins`
    : invite?.phase === 4
      ? "Draw"
      : invite?.phase === 3
        ? "Table refunded"
        : "Match complete";
  const resultDetail = hasWinner
    ? `${winnerSeat} ${short(invite.winner)} · ${invite.claimed ? "Prize paid" : "Payout pending"}`
    : invite?.claimed
      ? "Any funded stakes were returned."
      : "Refunds pending.";
  const guidance = !INVITE_ADDRESS
    ? "This invite points to an unsupported contract."
    : !account
      ? "Connect your Sepolia wallet to play."
      : !invite
        ? "Open a table to play or share it with a friend."
        : pendingStake
          ? "A stake was submitted. Confirm its transfer before it counts."
          : sealed
            ? "Both stakes are confirmed. Verify the result to settle the match."
            : settlementPending
              ? "Complete the payout below to settle this table."
              : expired
                ? "This invite has expired."
                : myCommitted
                  ? "Waiting for the other player to confirm their stake."
                  : canCommit
                    ? "Stake 1 test token to submit your encrypted score. Both players must confirm before the result is revealed."
                    : waiting && !seated
                      ? "An open seat is available at this table."
                      : "Pick a shell in each of three hands. Your score stays encrypted.";

  return (
    <main className="table-room">
      <div className="table-desk">
        <section className="table-stage" aria-label="Shell Table game">
          <header className="marquee">
            <span className="table-network">
              <span aria-hidden="true" />
              Sepolia testnet
            </span>
            <h1>Shell Table</h1>
            <p>Two players. Three picks. The higher encrypted score wins.</p>
          </header>
          <div className="felt-wrap">
            <div className="felt">
              {showScene && <ShellScene picking={picking} revealed={ballKnown ? myBall : -1} />}
              <div className="table-rail">
                <span>
                  {picking
                    ? `Pick a shell · Hand ${myHands + 1}/${HANDS}`
                    : invite
                      ? `Table ${inviteId}`
                      : "Three-shell table"}
                </span>
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
        </section>
        <aside className="table-console" aria-label="Table controls">
          <header className="console-heading">
            <h2>{invite ? `Table ${inviteId}` : "Play a match"}</h2>
            {invite && (
              <a href={addressUrl(INVITE_ADDRESS)} target="_blank" rel="noreferrer">
                Contract ↗
              </a>
            )}
          </header>
          <div className="table-seats">
            {SLOTS.map((slot) => {
              const player = slot === 0 ? invite?.player0 : invite?.player1;
              const hands = (slot === 0 ? invite?.hostHands : invite?.guestHands) ?? 0;
              const committed = slot === 0 ? invite?.hostCommitted : invite?.guestCommitted;
              return (
                <div className="table-seat" key={slot}>
                  <div className="seat-name">
                    <strong>{slot === 0 ? "Host" : "Guest"}</strong>
                    <span>
                      {player ? short(player) || "Open seat" : "Open seat"}
                      {mySlot === slot ? " · You" : ""}
                    </span>
                  </div>
                  <div
                    className="seat-progress"
                    aria-label={`${hands} of ${HANDS} hands${committed ? ", stake confirmed" : ""}`}
                  >
                    {[1, 2, 3].map((hand) => (
                      <i key={hand} data-played={hand <= hands} />
                    ))}
                    <small>{committed ? "Staked" : `${hands}/${HANDS}`}</small>
                  </div>
                </div>
              );
            })}
          </div>
          {invite && !legacy && (invite.claimed || settlementPending) && (
            <div className="table-result" data-paid={invite.claimed} role="status">
              <strong>{resultTitle}</strong>
              <span>{resultDetail}</span>
            </div>
          )}
          <p role="status" className={`table-msg ${error ? "bad" : "info"}`}>
            {error ||
              readError ||
              status ||
              (ballKnown && !pendingStake && !sealed && !settlementPending && !invite?.claimed
                ? myBall === 3
                  ? "Draw void. Both stakes are returned at settlement."
                  : myBall === chosen
                    ? "You found the ball. Your score stays encrypted."
                    : "The ball was under another shell."
                : guidance)}
          </p>
          <div className="table-controls">
            {!account && <TableWalletConnect />}
            {canStartFast && !picking && (
              <button type="button" disabled={busy} onClick={startRound}>
                {invite ? "Join and play hand 1" : "Open and play hand 1"}
              </button>
            )}
            {!!account && !invite && !(canStartFast && picking) && (
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
            {sealed && (
              <button type="button" disabled={!account || busy} onClick={() => void claim(fast)}>
                {legacy
                  ? "Submit original prize claim"
                  : fast
                    ? "Verify result and send payout"
                    : "Verify match result"}
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
                    {open
                      ? `Confirm ${slot === 0 ? "host" : "guest"} stake`
                      : pending
                        ? `Confirm ${slot === 0 ? "host" : "guest"} payout`
                        : `Send ${slot === 0 ? "host" : "guest"} payout`}
                  </button>
                );
              })}
            </div>
          )}
          {link && invite && (
            <div className="invite-link">
              <div>
                <strong>Invite a player</strong>
                {open && <p>{timeLeft(invite.deadline, now)}</p>}
              </div>
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
                {copied ? "Copied" : "Copy invite"}
              </button>
            </div>
          )}
          {invite?.claimed && legacy && (
            <p className="table-msg good">Original claim recorded. Check the transfer on Sepolia.</p>
          )}
        </aside>
      </div>
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
