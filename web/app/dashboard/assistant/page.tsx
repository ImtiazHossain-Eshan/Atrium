import AssistantPanel from '../../components/AssistantPanel';

export default function AssistantPage() {
  return <main className="dashboard-shell"><div className="dashboard-top"><div><span className="section-mark">Role-aware help</span><h1>Ask the assistant.</h1><p>It uses your signed-in role, not a prompt asking you to declare who you are.</p></div></div><AssistantPanel /></main>;
}
