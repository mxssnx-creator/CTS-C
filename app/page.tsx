import { SessionGate } from "@/components/terminal/session"
import { TradingTerminal } from "@/components/terminal/trading-terminal"
export default function Home() { return <SessionGate><TradingTerminal /></SessionGate> }
