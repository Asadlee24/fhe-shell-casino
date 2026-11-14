"use client";

import { useEffect, useRef, useState } from "react";

type Cue = "shuffle" | "pick" | "reveal" | "hit" | "win";
const notes: Record<Cue, [pitch: number, endPitch: number, delay: number, duration: number][]> = {
  shuffle: [
    [180, 105, 0, 0.09],
    [205, 120, 0.11, 0.09],
    [165, 90, 0.22, 0.12],
  ],
  pick: [[295, 126, 0, 0.085]],
  reveal: [[740, 490, 0, 0.13]],
  hit: [
    [740, 520, 0, 0.11],
    [660, 660, 0.08, 0.17],
  ],
  win: [
    [392, 392, 0, 0.2],
    [494, 494, 0.1, 0.2],
    [587, 587, 0.2, 0.24],
  ],
};

export function useShellSound() {
  const [muted, setMuted] = useState(false);
  const context = useRef<{ audio: AudioContext; master: GainNode } | null>(null);

  useEffect(() => {
    try {
      setMuted(localStorage.getItem("shell-table-sound") === "off");
    } catch {
      /* optional storage */
    }
    return () => {
      const current = context.current;
      context.current = null;
      if (current) void current.audio.close().catch(() => {});
    };
  }, []);

  function playSound(cue: Cue, gesture = false, enabled = !muted) {
    if (!enabled) return;
    try {
      if (!context.current && gesture) {
        const audio = new AudioContext();
        const master = audio.createGain();
        master.gain.value = 0.24;
        master.connect(audio.destination);
        context.current = { audio, master };
      }
      const current = context.current;
      if (!current) return;
      const { audio, master } = current;
      const play = () => {
        if (context.current !== current || audio.state !== "running" || master.gain.value === 0) return;
        for (const [pitch, endPitch, delay, duration] of notes[cue]) {
          const start = audio.currentTime + delay + 0.012;
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = cue === "pick" || cue === "shuffle" ? "triangle" : "sine";
          oscillator.frequency.setValueAtTime(pitch, start);
          oscillator.frequency.exponentialRampToValueAtTime(endPitch, start + duration);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(cue === "shuffle" ? 0.09 : 0.13, start + 0.009);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
          oscillator.connect(gain).connect(master);
          oscillator.start(start);
          oscillator.stop(start + duration);
        }
      };
      if (audio.state === "running") play();
      else if (gesture)
        void audio
          .resume()
          .then(play)
          .catch(() => {});
    } catch {
      /* play remains available without Web Audio */
    }
  }

  function toggleSound() {
    const next = !muted;
    setMuted(next);
    if (context.current) context.current.master.gain.value = next ? 0 : 0.24;
    try {
      localStorage.setItem("shell-table-sound", next ? "off" : "on");
    } catch {
      /* optional storage */
    }
    if (!next) playSound("pick", true, true);
  }

  return { muted, toggleSound, playSound };
}
