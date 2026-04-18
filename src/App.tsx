/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from "react";
import { Bot, Server, Clock, AlertCircle, CheckCircle2, Activity } from "lucide-react";

interface BotStatus {
  status: "online" | "offline" | "error" | "missing_token";
  servers: number;
  uptime: number;
  hasToken: boolean;
  hasGuildId: boolean;
  error?: string;
}

export default function App() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isWarmingUp, setIsWarmingUp] = useState(true);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/bot-status");
        
        // If we get a 404 or other error, the server might still be starting
        if (!res.ok) {
          if (res.status === 404 || res.status === 502 || res.status === 503 || res.status === 504) {
            setIsWarmingUp(true);
            return;
          }
          throw new Error(`HTTP error! status: ${res.status}`);
        }

        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
          // This is likely the "Starting Server..." HTML page
          setIsWarmingUp(true);
          return;
        }

        const data = await res.json();
        setStatus(data);
        setFetchError(null);
        setIsWarmingUp(false);
      } catch (err) {
        console.error("Failed to fetch bot status", err);
        
        // If the fetch itself fails (network error), the server might be restarting.
        // We revert to warming up state to give it a chance to recover without showing a big red error immediately.
        setIsWarmingUp((prev) => {
          // If we were already online, and now it failed, maybe show error after a few retries
          return true;
        });

        if (!isWarmingUp) {
          setFetchError("Connection lost. Nova might be restarting...");
        }
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
  };

  return (
    <div className="min-h-screen bg-bg text-ink font-sans p-8 flex justify-center">
      <div className="w-full max-w-4xl flex flex-col">
        <header className="h-16 border-b border-black/5 mb-8 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center shadow-[0_2px_4px_rgba(0,0,0,0.05)] text-accent">
              <Bot size={24} />
            </div>
            <h1 className="font-serif italic text-xl">StudyBot Dashboard</h1>
          </div>
          <div className="inline-block px-4 py-1.5 bg-[#F8F7F3] rounded-full text-xs uppercase tracking-widest text-muted border border-black/5">
            Session: Deep Work
          </div>
        </header>

        {isWarmingUp && !fetchError ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="animate-spin text-accent">
              <Activity size={32} />
            </div>
            <p className="text-muted italic animate-pulse">Nova is waking up... Please wait.</p>
          </div>
        ) : (
          <div className="space-y-8">
            {fetchError && (
              <div className="p-4 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 flex items-center gap-3">
                <AlertCircle size={24} />
                <div>
                  <h3 className="font-semibold">Dashboard Connection Error</h3>
                  <p className="text-sm opacity-80">{fetchError}</p>
                </div>
              </div>
            )}

            {status && (
              <div className="grid grid-cols-1 md:grid-cols-[1fr_300px] gap-6 flex-1">
                <div className="flex flex-col gap-6">
                  {/* Status Banner -> Timer Card style */}
                  <div className="bg-white rounded-[32px] p-10 text-center shadow-[0_8px_24px_rgba(0,0,0,0.03)]">
                    <span className="inline-block px-4 py-1.5 bg-[#F8F7F3] rounded-full text-xs uppercase tracking-widest text-muted border border-black/5">
                      Bot Status
                    </span>
                    <div className="font-serif text-5xl font-light text-accent my-4">
                      {status.status === "online" ? "Online" : 
                       status.status === "missing_token" ? "Missing Token" : 
                       status.status === "error" ? "Connection Error" : "Offline"}
                    </div>
                    <p className="text-muted text-sm italic">
                      {status.status === "online" 
                        ? "The bot is connected to Discord and ready to receive commands." 
                        : status.status === "missing_token"
                        ? "Please add your DISCORD_TOKEN to the environment variables."
                        : status.status === "error"
                        ? `Error: ${status.error || "Unknown connection error"}`
                        : "There was an error connecting to Discord."}
                    </p>
                <div className="flex justify-center gap-4 mt-6">
                  {status.status === "online" ? (
                    <button className="px-8 py-3 rounded-full border-none font-semibold cursor-pointer text-sm bg-accent text-white">
                      Connected
                    </button>
                  ) : (
                    <button className="px-8 py-3 rounded-full border border-accent font-semibold cursor-pointer text-sm bg-transparent text-accent">
                      Check Connection
                    </button>
                  )}
                </div>
              </div>

              {/* Stats Row */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white p-5 rounded-[20px] border border-black/5">
                  <div className="text-[11px] uppercase text-muted tracking-widest flex items-center gap-2">
                    <Server size={14} /> Servers
                  </div>
                  <div className="font-serif text-2xl mt-1">{status.servers}</div>
                </div>

                <div className="bg-white p-5 rounded-[20px] border border-black/5">
                  <div className="text-[11px] uppercase text-muted tracking-widest flex items-center gap-2">
                    <Clock size={14} /> Uptime
                  </div>
                  <div className="font-serif text-2xl mt-1">{formatUptime(status.uptime)}</div>
                </div>

                <div className="bg-white p-5 rounded-[20px] border border-black/5">
                  <div className="text-[11px] uppercase text-muted tracking-widest flex items-center gap-2">
                    <Activity size={14} /> Guild ID
                  </div>
                  <div className={`font-serif text-2xl mt-1 ${status.hasGuildId ? "text-green-500" : "text-orange-500"}`}>
                    {status.hasGuildId ? "Configured" : "Missing"}
                  </div>
                </div>
              </div>
            </div>

            {/* Features Info -> Members Panel style */}
            <div className="bg-white/40 rounded-[24px] p-6 flex flex-col gap-4">
              <p className="font-serif italic text-[1.1rem] mb-2">Available Commands</p>
              
              <div className="flex items-center gap-3 p-2 rounded-xl bg-white/50">
                <div className="w-8 h-8 rounded-full bg-[#D1D1C6] border-2 border-white flex items-center justify-center text-accent shrink-0">
                  <Clock size={16} />
                </div>
                <div>
                  <div className="text-[0.85rem] font-semibold">/pomodoro</div>
                  <div className="text-[0.7rem] text-muted">Starts a focus timer</div>
                </div>
              </div>

              <div className="flex items-center gap-3 p-2 rounded-xl bg-white/50">
                <div className="w-8 h-8 rounded-full bg-[#A3A380] border-2 border-white flex items-center justify-center text-white shrink-0">
                  <CheckCircle2 size={16} />
                </div>
                <div>
                  <div className="text-[0.85rem] font-semibold">/todo</div>
                  <div className="text-[0.7rem] text-muted">Manage study tasks</div>
                </div>
              </div>

              <div className="flex items-center gap-3 p-2 rounded-xl bg-white/50">
                <div className="w-8 h-8 rounded-full bg-[#D8E2DC] border-2 border-white flex items-center justify-center text-accent shrink-0">
                  <Bot size={16} />
                </div>
                <div>
                  <div className="text-[0.85rem] font-semibold">/study</div>
                  <div className="text-[0.7rem] text-muted">Get a motivational quote</div>
                </div>
              </div>

              <div className="mt-auto bg-accent text-white p-4 rounded-2xl text-[0.8rem]">
                <strong>Active Commands</strong>
                <div className="font-mono opacity-80 mt-1">/pomodoro [study] [break] [task]</div>
                <div className="font-mono opacity-80 mt-1">/break [hours] [minutes] [seconds]</div>
                <div className="font-mono opacity-80 mt-1">/pause | /stop</div>
                <div className="font-mono opacity-80 mt-1">/todo [add|list|complete|remove]</div>
                <div className="font-mono opacity-80 mt-1">/note [text] | /journal</div>
                <div className="font-mono opacity-80 mt-1">/study | /rank | /leaderboard</div>
                <div className="mt-2 text-[0.7rem] opacity-70 italic">
                  Level Roles: Stardust (Lvl 2) | Comet (Lvl 10) | Supernova (Lvl 25)
                </div>
                <div className="font-mono opacity-80 mt-1">/test-summary | /test-pomodoro | /test-xp</div>
              </div>
            </div>
          </div>
        )}
        </div>
      )}
    </div>
  </div>
);
}
