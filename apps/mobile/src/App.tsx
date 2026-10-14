import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import Constants from "expo-constants";
import { ZodError } from "zod";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import type { Activity, BankState, Clarification, Interpretation, Journey, MobileTokens, Operation, Review } from "./api";
import { ApiError, MobileTokens as MobileTokensSchema, mobileApi, publicConfig } from "./api";
import { describeCandidate, holdingValue, money, quotedPortfolioValues, sgdReserveMinorUnits } from "./presentation";
import { verifiedCustomerSnapshot } from "./sync";
import { connectionConfigured, discoveryUrl, trustedDiscovery } from "./connection";

WebBrowser.maybeCompleteAuthSession();
const C = { red: "#b3272d", ink: "#18222d", muted: "#64717f", bg: "#f5f6f7", line: "#e5e8eb", white: "#fff", pale: "#fff1f1", green: "#1d795b" };
type Tab = "Home" | "Pay & Transfer" | "Investments" | "Activity" | "Profile";
type Flow = { phase: "COMPOSE"; draft: string; voice?: { rawTranscript: string; provider: string; transcribedAt: string } }
  | { phase: "WORKING"; label: string }
  | { phase: "CLARIFY"; data: Extract<Interpretation, { clarificationId: string }>; request: string }
  | { phase: "MEANING"; data: Extract<Interpretation, { candidateId: string }>; request: string }
  | { phase: "PLAN"; review: Review; request: string }
  | { phase: "FUNDING"; goalId: string; request: string; detail: string }
  | { phase: "STOP"; title: string; detail: string };
const stages = ["AI Interpretation", "Meaning Confirmation", "Deterministic Plan", "Passkey Authorization", "Bank Execution", "Verified Outcome"];

function formatDate(value: string) { return new Date(value).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Singapore" }); }
function errorText(error: unknown) { return error instanceof ApiError ? error.code.replaceAll("_", " ").toLowerCase() : error instanceof ZodError || error instanceof Error && (error.message === "CUSTOMER_STATE_MISMATCH" || error.message === "STATE_VERSION_REGRESSED") ? "Bank data could not be verified. Refresh or contact support." : "Could not connect. Check your network and try again."; }
function Btn({ title, onPress, secondary = false, disabled = false }: { title: string; onPress(): void; secondary?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled} onPress={onPress} style={[styles.button, secondary && styles.buttonSecondary, disabled && styles.disabled]}><Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{title}</Text></Pressable>;
}
function Card({ children, title }: { children: React.ReactNode; title?: string }) { return <View style={styles.card}>{title ? <Text style={styles.cardTitle}>{title}</Text> : null}{children}</View>; }
function Tag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "red" | "green" }) { return <Text style={[styles.tag, tone === "red" && styles.tagRed, tone === "green" && styles.tagGreen]}>{children}</Text>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <Card><Text style={styles.cardTitle}>{title}</Text><Text style={styles.body}>{detail}</Text></Card>; }
function Section({ title, action }: { title: string; action?: string }) { return <View style={styles.sectionHead}><Text style={styles.sectionTitle}>{title}</Text>{action && <Text style={styles.sectionAction}>{action}</Text>}</View>; }

function useSession() {
  const configurationKey = `${publicConfig.apiBaseUrl}\0${publicConfig.oidcIssuer}\0${publicConfig.oidcClientId}\0${publicConfig.oidcAudience}`;
  const [discovery, setDiscovery] = useState<AuthSession.DiscoveryDocument | null>(null);
  const redirectUri = AuthSession.makeRedirectUri({ scheme: "parlance", path: "auth" });
  const [request, response, prompt] = AuthSession.useAuthRequest({ clientId: publicConfig.oidcClientId || "unconfigured", responseType: AuthSession.ResponseType.Code, redirectUri, scopes: ["openid", "profile"], usePKCE: true, extraParams: { audience: publicConfig.oidcAudience } }, discovery);
  const [tokens, setTokens] = useState<MobileTokens>(); const [loading, setLoading] = useState(true); const [error, setError] = useState<string>();
  const refreshing = useRef<Promise<string | undefined> | null>(null);
  const token = tokens?.accessToken;
  const configured = connectionConfigured(publicConfig);
  useEffect(() => {
    if (!configured) return;
    let active = true;
    void fetch(discoveryUrl(publicConfig.oidcIssuer)).then(async (response) => {
      if (!response.ok) throw new Error("IDENTITY_DISCOVERY_UNAVAILABLE");
      const value = trustedDiscovery(publicConfig.oidcIssuer, await response.json());
      if (!value) throw new Error("IDENTITY_DISCOVERY_UNTRUSTED");
      if (active) setDiscovery(value);
    }).catch((failure) => { if (active) setError(failure instanceof Error && failure.message === "IDENTITY_DISCOVERY_UNTRUSTED" ? "Identity provider configuration could not be verified." : "Identity provider is unavailable. Try again later."); });
    return () => { active = false; };
  }, [configured]);
  const persist = useCallback(async (next: MobileTokens) => { await SecureStore.setItemAsync("parlance.mobile.session", JSON.stringify({ configurationKey, tokens: next })); setTokens(next); }, [configurationKey]);
  useEffect(() => { void (async () => {
    try {
      await SecureStore.deleteItemAsync("parlance.mobile.token"); await SecureStore.deleteItemAsync("parlance.mobile.refresh");
      const stored = await SecureStore.getItemAsync("parlance.mobile.session");
      if (stored) { const envelope: unknown = JSON.parse(stored); const value = envelope && typeof envelope === "object" && "configurationKey" in envelope && envelope.configurationKey === configurationKey && "tokens" in envelope ? envelope.tokens : undefined; const parsed = MobileTokensSchema.safeParse(value); if (parsed.success) setTokens(parsed.data); else await SecureStore.deleteItemAsync("parlance.mobile.session"); }
    } catch { setError("Secure session storage is unavailable."); }
    finally { setLoading(false); }
  })(); }, [configurationKey]);
  useEffect(() => {
    if (response?.type !== "success" || !discovery || !request?.codeVerifier) return;
    void (async () => {
      try {
        const result = await AuthSession.exchangeCodeAsync({ clientId: publicConfig.oidcClientId, code: response.params.code, redirectUri, extraParams: { code_verifier: request.codeVerifier! } }, discovery);
        await persist(await mobileApi.exchange(result.accessToken));
        setError(undefined);
      } catch { setError("Sign-in could not be completed. Try again."); }
    })();
  }, [response, discovery, request?.codeVerifier, redirectUri, persist]);
  const renew = useCallback(async (): Promise<string | undefined> => {
    if (!tokens) return;
    if (refreshing.current) return refreshing.current;
    const pending = (async () => {
      try { const next = await mobileApi.refreshSession(tokens.refreshToken); await persist(next); setError(undefined); return next.accessToken; }
      catch (failure) {
        if (failure instanceof ApiError && failure.status === 401) { await SecureStore.deleteItemAsync("parlance.mobile.session"); setTokens(undefined); setError("Your session expired. Sign in again."); return; }
        throw failure;
      }
    })();
    refreshing.current = pending;
    try { return await pending; } finally { refreshing.current = null; }
  }, [tokens, persist]);
  useEffect(() => { if (!tokens) return; const delay = Math.max(1000, Date.parse(tokens.accessExpiresAt) - Date.now() - 60000); const timer = setTimeout(() => { void renew().catch(() => setError("Could not renew your session. Check your connection.")); }, delay); return () => clearTimeout(timer); }, [tokens, renew]);
  const call = useCallback(async <T,>(operation: (accessToken: string) => Promise<T>): Promise<T> => {
    if (!tokens) throw new ApiError("SESSION_EXPIRED", 401);
    const current = Date.parse(tokens.accessExpiresAt) <= Date.now() + 30000 ? await renew() : tokens.accessToken;
    if (!current) throw new ApiError("SESSION_EXPIRED", 401);
    try { return await operation(current); }
    catch (failure) {
      if (!(failure instanceof ApiError) || failure.status !== 401) throw failure;
      const next = await renew(); if (!next) throw new ApiError("SESSION_EXPIRED", 401);
      return operation(next);
    }
  }, [tokens, renew]);
  const signOut = useCallback(async () => {
    if (!tokens) return;
    try { await mobileApi.revokeSession(tokens.refreshToken); await SecureStore.deleteItemAsync("parlance.mobile.session"); setTokens(undefined); setError(undefined); }
    catch { setError("Could not revoke your session. Check your connection and try again."); }
  }, [tokens]);
  const signIn = () => { if (!discovery) { setError("Identity provider is not ready. Check your connection and try again."); return; } void prompt().catch(() => setError("Sign-in could not be opened. Try again.")); };
  return { token, loading, configured, error, signIn, signOut, call };
}

function AppContent() {
  const session = useSession(); const [tab, setTab] = useState<Tab>("Home"); const [state, setState] = useState<BankState>(); const [activity, setActivity] = useState<Activity>();
  const latestState = useRef<BankState | undefined>(undefined); const sessionToken = useRef(session.token); sessionToken.current = session.token;
  const [now, setNow] = useState(Date.now());
  const [userId, setUserId] = useState<string>(); const [operations, setOperations] = useState<Operation[]>([]); const [journeys, setJourneys] = useState<Journey[]>([]); const [busy, setBusy] = useState(false); const [syncError, setSyncError] = useState<string>(); const [search, setSearch] = useState("");
  const [flow, setFlow] = useState<Flow>({ phase: "COMPOSE", draft: "" }); const [listening, setListening] = useState(false); const [voiceError, setVoiceError] = useState<string>();
  const [clarificationAnswer, setClarificationAnswer] = useState(""); const [fundingReserve, setFundingReserve] = useState("");
  useSpeechRecognitionEvent("start", () => setListening(true));
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("result", (event) => { const transcript = event.results[0]?.transcript?.trim(); if (transcript && event.isFinal) { setFlow({ phase: "COMPOSE", draft: transcript, voice: { rawTranscript: transcript, provider: "android-speech-recognizer", transcribedAt: new Date().toISOString() } }); setTab("Pay & Transfer"); } });
  useSpeechRecognitionEvent("error", () => { setListening(false); setVoiceError("Voice recognition is unavailable. You can type your request."); });
  const load = useCallback(async () => {
    const requestedToken = session.token;
    setBusy(true); setSyncError(undefined);
    try { const [identity, banking, recent, runs, saved] = await Promise.all([session.call(mobileApi.session), session.call(mobileApi.state), session.call(mobileApi.activity), session.call(mobileApi.operations), session.call(mobileApi.journeys)]); if (sessionToken.current !== requestedToken) return; const accepted = verifiedCustomerSnapshot(identity.userId, banking, latestState.current); latestState.current = accepted; setUserId(identity.userId); setState(accepted); setActivity(recent); setOperations(runs); setJourneys(saved); }
    catch (error) { if (sessionToken.current === requestedToken) setSyncError(errorText(error)); }
    finally { setBusy(false); }
  }, [session.call, session.token]);
  useEffect(() => { if (session.token) void load(); else { latestState.current = undefined; setState(undefined); setActivity(undefined); setOperations([]); setJourneys([]); setUserId(undefined); } }, [session.token, load]);
  useEffect(() => { const sub = AppState.addEventListener("change", (next) => { if (next === "active" && session.token) void load(); }); return () => sub.remove(); }, [session.token, load]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const draft = (text: string) => { setFlow({ phase: "COMPOSE", draft: text }); setTab("Pay & Transfer"); };
  const resume = (journey: Journey) => { setFlow({ ...journey.flow, request: journey.request }); setTab("Pay & Transfer"); };
  const submit = async () => {
    if (!session.token || flow.phase !== "COMPOSE" || !flow.draft.trim()) return;
    const text = flow.draft.trim(); const voice = flow.voice;
    setFlow({ phase: "WORKING", label: "Checking your request against your banking records…" });
    try { await handleInterpretation(await session.call((token) => mobileApi.message(token, text, voice)), text); }
    catch (error) { setFlow({ phase: "STOP", title: "Request unavailable", detail: errorText(error) }); }
  };
  const handleInterpretation = async (result: Interpretation, requestText: string) => {
    if (result.status === "SEMANTIC_VALIDATION_FAILED") setFlow({ phase: "STOP", title: "Please clarify your request", detail: result.message });
    else if (result.status === "NEEDS_CLARIFICATION" || result.status === "NEEDS_BUNDLE_CLARIFICATION") setFlow({ phase: "CLARIFY", data: result, request: requestText });
    else setFlow({ phase: "MEANING", data: result, request: requestText });
  };
  const clarify = async (answer: { selectedCandidateId: string } | { answerText: string }) => {
    if (!session.token || flow.phase !== "CLARIFY") return; const prior = flow; setFlow({ phase: "WORKING", label: "Checking your choice…" });
    try { await handleInterpretation(await session.call((token) => mobileApi.clarify(token, prior.data.status === "NEEDS_BUNDLE_CLARIFICATION", prior.data.clarificationId, answer)), prior.request); setClarificationAnswer(""); }
    catch (error) { setFlow({ phase: "STOP", title: "Could not confirm the choice", detail: errorText(error) }); }
  };
  const confirm = async () => {
    if (!session.token || flow.phase !== "MEANING") return; const prior = flow; const bundle = prior.data.status === "AWAITING_BUNDLE_CONFIRMATION";
    setFlow({ phase: "WORKING", label: "Preparing a deterministic financial plan…" });
    try {
      const subject = await session.call((token) => mobileApi.confirm(token, bundle, prior.data.candidateId));
      const id = bundle ? (subject as { bundleId: string }).bundleId : (subject as { id: string }).id;
      const result = await session.call((token) => mobileApi.compile(token, bundle, id));
      if ("steps" in result) setFlow({ phase: "PLAN", review: { kind: bundle ? "BUNDLE" : "GOAL", id, subject, plan: result }, request: prior.request });
      else if (!bundle && "goal" in subject && subject.goal.type === "ACQUIRE_ASSET" && result.reason?.code === "INSUFFICIENT_FUNDS") setFlow({ phase: "FUNDING", goalId: id, request: prior.request, detail: result.reason.message });
      else setFlow({ phase: "STOP", title: "A safe plan is not available", detail: result.reason?.message ?? result.status });
      void load();
    } catch (error) { setFlow({ phase: "STOP", title: "Could not prepare the plan", detail: errorText(error) }); }
  };
  const refreshPlan = async () => {
    if (!session.token || flow.phase !== "PLAN") return; const prior = flow; setFlow({ phase: "WORKING", label: "Refreshing quote and account state…" });
    try { const result = await session.call((token) => mobileApi.compile(token, prior.review.kind === "BUNDLE", prior.review.id)); if ("steps" in result) setFlow({ ...prior, review: { ...prior.review, plan: result } }); else setFlow({ phase: "STOP", title: "Plan needs a new request", detail: result.reason?.message ?? result.status }); void load(); }
    catch (error) { setFlow({ phase: "STOP", title: "Refresh unavailable", detail: errorText(error) }); }
  };
  const reviewFunding = async (sourceAccountId: string) => {
    if (!session.token || flow.phase !== "FUNDING") return;
    const prior = flow; const reserve = fundingReserve.trim() ? sgdReserveMinorUnits(fundingReserve) : undefined;
    if (fundingReserve.trim() && reserve === undefined) return;
    setFlow({ phase: "WORKING", label: "Preparing a funding option for your review…" });
    try { await handleInterpretation(await session.call((token) => mobileApi.proposeFunding(token, prior.goalId, sourceAccountId, reserve)), prior.request); setFundingReserve(""); void load(); }
    catch (error) { setFlow({ phase: "STOP", title: "Funding review unavailable", detail: errorText(error) }); }
  };
  const voice = async () => { setVoiceError(undefined); try { const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync(); if (!permission.granted) { setVoiceError("Microphone access was denied. Type your request instead."); return; } ExpoSpeechRecognitionModule.start({ lang: "en-SG", interimResults: false, continuous: false }); } catch { setVoiceError("Voice recognition is unavailable. Type your request instead."); } };
  const stopVoice = () => ExpoSpeechRecognitionModule.stop();
  const investmentValue = useMemo(() => state ? quotedPortfolioValues(state.holdings, state.assetQuotes, now) : [], [state, now]);
  const matchingPayees = useMemo(() => state?.beneficiaries.filter((payee) => payee.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [], [state, search]);

  if (session.loading) return <SafeAreaView style={styles.center}><Text style={styles.brand}>PARLANCE</Text><Text style={styles.body}>Opening secure session…</Text></SafeAreaView>;
  if (session.token && !userId) return <SafeAreaView style={styles.signedOut}><Text style={styles.brand}>PARLANCE</Text><Text style={styles.hero}>Connecting securely…</Text><Text style={styles.body}>{syncError ? `Could not load customer data: ${syncError}` : "Verifying your session and loading current banking data."}</Text>{syncError && <><Btn title="Try again" onPress={() => void load()} /><Btn title="Sign out" secondary onPress={() => void session.signOut()} /></>}</SafeAreaView>;
  if (!session.configured || !session.token) return <SafeAreaView style={styles.signedOut}><Text style={styles.brand}>PARLANCE</Text><Text style={styles.hero}>Banking, in your own words.</Text><Text style={styles.body}>Your accounts and transactions appear after secure customer sign-in.</Text><Card title={session.configured ? "Secure sign-in" : "Connection setup required"}><Text style={styles.body}>{session.configured ? "Continue with your bank identity provider. Your banking credentials are never stored in the app." : "An HTTPS customer API and OIDC identity provider must be configured before customer data can be accessed."}</Text>{session.configured && <Btn title="Sign in securely" onPress={session.signIn} />}{session.error && <Text style={styles.error}>{session.error}</Text>}</Card><Text style={styles.footnote}>Financial authorization is unavailable on Android until native passkey verification is completed.</Text></SafeAreaView>;
  return <SafeAreaView style={styles.root}><StatusBar barStyle="dark-content" backgroundColor={C.bg} /><View style={styles.top}><View><Text style={styles.eyebrow}>DBS · PARLANCE</Text><Text style={styles.topTitle}>{tab}</Text></View><Pressable onPress={() => session.token && void load()} accessibilityRole="button" accessibilityLabel="Refresh banking data"><Text style={styles.refresh}>↻</Text></Pressable></View>
    {session.error && <View style={styles.notice}><Text style={styles.error}>{session.error}</Text></View>}
    {syncError && <View style={styles.notice}><Text style={styles.error}>Connection issue: {syncError}</Text><Text style={styles.footnote}>Displayed data may be out of date. Refresh before reviewing a plan.</Text></View>}
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={busy} onRefresh={() => session.token && void load()} tintColor={C.red} />}>
      {tab === "Home" && <><Text style={styles.hero}>Welcome back.</Text><Text style={styles.body}>Your financial overview, updated from the bank.</Text><Section title="Your accounts" action={state ? `State ${state.stateVersion}` : undefined} />{state?.accounts.map((account) => <Card key={account.id}><View style={styles.row}><Text style={styles.cardTitle}>{account.currency} account</Text><Tag tone={account.status === "ACTIVE" ? "green" : "red"}>{account.status}</Tag></View><Text style={styles.balance}>{money(account.currency, account.availableMinorUnits)}</Text><Text style={styles.caption}>Available · Ledger {money(account.currency, account.ledgerMinorUnits)}</Text></Card>)}<Section title="Quick actions" /><View style={styles.quick}><Btn title="Send" onPress={() => setTab("Pay & Transfer")} /><Btn title="Invest" onPress={() => setTab("Investments")} secondary /><Btn title="AI Assistant" onPress={() => draft("")} secondary /></View><Section title="Investments" /><Card><Text style={styles.cardTitle}>Portfolio overview</Text><Text style={styles.balance}>{investmentValue?.length ? investmentValue.map((item) => money(item.currency, item.minorUnits)).join(" · ") : "No fresh valuation"}</Text><Text style={styles.caption}>{state?.holdings.length ?? 0} holdings · Synthetic bank quotes</Text></Card><Section title="Recent activity" />{activity?.items.slice(0, 3).map((item, index) => <ActivityRow key={`${item.occurredAt}:${index}`} item={item} />)}{!activity?.items.length && <Empty title="No completed activity" detail="Completed transfers and purchases will appear here." />}{state && <Text style={styles.footnote}>Bank state captured {formatDate(state.capturedAt)}. Pull down to refresh.</Text>}</>}
      {tab === "Pay & Transfer" && <><Text style={styles.body}>Choose a saved payee or tell Parlance what you want to do. Selecting a payee only prepares an editable request.</Text><Section title="Saved requests" />{journeys.slice(0, 5).map((journey) => <Card key={journey.id}><View style={styles.row}><Text style={styles.cardTitle}>{journey.flow.phase === "PLAN" ? "Plan ready to review" : journey.flow.phase === "MEANING" ? "Meaning to confirm" : "Clarification needed"}</Text><Tag>{formatDate(journey.updatedAt)}</Tag></View><Text style={styles.body}>{journey.request}</Text><Btn title="Resume request" secondary onPress={() => resume(journey)} /></Card>)}{journeys.length === 0 && <Text style={styles.footnote}>No saved requests waiting for review.</Text>}<Section title="Saved payees" /><TextInput style={styles.input} placeholder="Search saved payees" placeholderTextColor={C.muted} value={search} onChangeText={setSearch} accessibilityLabel="Search saved payees" />{matchingPayees.map((payee) => <Card key={payee.id}><View style={styles.row}><Text style={styles.cardTitle}>{payee.name}</Text><Tag tone={payee.status === "ACTIVE" ? "green" : "red"}>{payee.status}</Tag></View><Text style={styles.caption}>{payee.supportedCurrencies.join(", ")} transfers</Text>{payee.status === "ACTIVE" && <Btn title={`Send to ${payee.name}`} secondary onPress={() => draft(`Send money to ${payee.name}`)} />}</Card>)}{!state?.beneficiaries.length && <Empty title="No saved payees" detail="Your saved recipients will appear here when available." />}{!!state?.beneficiaries.length && matchingPayees.length === 0 && <Empty title="No matching payees" detail="Try a different name." />}<Section title="Ask Parlance" /><TrustJourney phase={flow.phase} /><Card><Conversation flow={flow} setFlow={setFlow} submit={submit} clarify={clarify} clarificationAnswer={clarificationAnswer} setClarificationAnswer={setClarificationAnswer} confirm={confirm} refreshPlan={refreshPlan} reviewFunding={reviewFunding} fundingReserve={fundingReserve} setFundingReserve={setFundingReserve} state={state} now={now} voice={voice} stopVoice={stopVoice} listening={listening} voiceError={voiceError} /></Card></>}
      {tab === "Investments" && <><Text style={styles.body}>Holdings and prices from your current synthetic bank state.</Text><Section title="Portfolio" /><Card><Text style={styles.caption}>Current quoted value</Text><Text style={styles.balance}>{investmentValue?.length ? investmentValue.map((item) => money(item.currency, item.minorUnits)).join(" · ") : "Unavailable"}</Text><Text style={styles.caption}>Values require a fresh quote. Historical returns are unavailable.</Text></Card><Section title="Holdings" />{state?.holdings.map((holding) => { const asset = state.assets.find((a) => a.id === holding.assetId); const quote = state.assetQuotes.find((q) => q.assetId === holding.assetId && Date.parse(q.expiresAt) > Date.now()); return <Card key={holding.assetId}><Text style={styles.cardTitle}>{asset?.name ?? "Investment"}</Text><Text style={styles.body}>{asset?.symbol} · {holding.quantity} shares</Text><Text style={styles.balanceSmall}>{quote ? money(quote.settlementCurrency, holdingValue(holding.quantity, quote.unitPriceMinor)) : "Fresh quote unavailable"}</Text>{asset?.tradable && <Btn title={`Buy more ${asset.symbol}`} onPress={() => draft(`Buy 1 share of ${asset.name} (${asset.symbol}).`)} />}</Card>; })}{!state?.holdings.length && <Empty title="No holdings yet" detail="Your confirmed investments will appear here." />}<Section title="Explore & invest" />{state?.assets.filter((a) => a.tradable).map((asset) => { const quote = state.assetQuotes.find((q) => q.assetId === asset.id && Date.parse(q.expiresAt) > Date.now()); return <Card key={asset.id}><Text style={styles.cardTitle}>{asset.name} · {asset.symbol}</Text><Text style={styles.body}>{quote ? `${money(quote.settlementCurrency, quote.unitPriceMinor)} per share · fee ${money(quote.settlementCurrency, quote.feeMinor)}` : "Quote unavailable"}</Text><Btn title={`Buy ${asset.symbol}`} secondary onPress={() => draft(`Buy 1 share of ${asset.name} (${asset.symbol}).`)} /></Card>; })}<Section title="Investment activity" />{activity?.items.filter((item) => /^Buy\s/iu.test(item.description)).map((item, index) => <ActivityRow key={`${item.occurredAt}:${index}`} item={item} />)}{!activity?.items.some((item) => /^Buy\s/iu.test(item.description)) && <Empty title="No investment activity" detail="Completed purchases will appear here." />}</>}
      {tab === "Activity" && <><Text style={styles.body}>Execution states and settled transactions reported by the server.</Text><Section title="Execution status" />{operations.map((operation) => <Card key={operation.executionId}><View style={styles.row}><Text style={styles.cardTitle}>Request {operation.executionId.slice(0, 8)}</Text><Tag tone={operation.status === "COMPLETED" ? "green" : operation.status === "FAILED" ? "red" : "neutral"}>{operation.status.replaceAll("_", " ")}</Tag></View><Text style={styles.caption}>{formatDate(operation.updatedAt)}</Text>{operation.steps.map((step, index) => <Text key={index} style={styles.body}>{step.action.replaceAll("_", " ")} · {step.status}{step.bankReference ? ` · ${step.bankReference}` : ""}</Text>)}{operation.finalStateVersion !== undefined && <Text style={styles.caption}>Final bank state {operation.finalStateVersion}</Text>}</Card>)}{operations.length === 0 && <Empty title="No execution records" detail="Authorized requests will appear here when available." />}<Section title="Settled activity" />{activity?.items.map((item, index) => <ActivityRow key={`${item.occurredAt}:${index}`} item={item} />)}{!activity?.items.length && <Empty title="No completed activity" detail="Transfers, conversions and purchases will appear here after settlement." />}</>}
      {tab === "Profile" && <><Section title="Your session" /><Card><Text style={styles.cardTitle}>Signed in</Text><Text style={styles.body}>Customer record: {userId}</Text><Text style={styles.caption}>The server verifies your token and resolves this customer record.</Text></Card><Section title="Security" /><Card><Text style={styles.cardTitle}>Passkey authorization</Text><Tag tone="red">Unavailable on Android</Tag><Text style={styles.body}>You can review plans here. Approval and execution stay blocked until native passkey association and backend verification are deployed.</Text></Card><Section title="Connection" /><Card><Text style={styles.body}>{syncError ? "Needs refresh" : busy ? "Refreshing" : "Connected"}</Text><Text style={styles.caption}>{state ? `Last bank snapshot: ${formatDate(state.capturedAt)}` : "No bank snapshot"}</Text><Btn title="Refresh now" secondary onPress={() => session.token && void load()} /></Card><Section title="App" /><Card><Text style={styles.body}>Parlance Android {Constants.expoConfig?.version ?? "0.1.0"}</Text><Btn title="Sign out" onPress={() => void session.signOut()} /></Card></>}
    </ScrollView></KeyboardAvoidingView><View style={styles.nav}>{(["Home", "Pay & Transfer", "Investments", "Activity", "Profile"] as Tab[]).map((item) => <Pressable key={item} onPress={() => setTab(item)} style={styles.navItem} accessibilityRole="tab" accessibilityState={{ selected: tab === item }}><Text style={[styles.navIcon, tab === item && styles.navActive]}>{({ Home: "⌂", "Pay & Transfer": "↗", Investments: "◈", Activity: "≡", Profile: "○" } as Record<Tab, string>)[item]}</Text><Text style={[styles.navLabel, tab === item && styles.navActive]} numberOfLines={1}>{item === "Pay & Transfer" ? "Pay" : item}</Text></Pressable>)}</View></SafeAreaView>;
}

function ActivityRow({ item }: { item: Activity["items"][number] }) { return <Card><View style={styles.row}><Text style={[styles.cardTitle, { flex: 1 }]}>{item.description}</Text><Text style={styles.amount}>−{money(item.amount.currency, item.amount.minorUnits)}</Text></View><Text style={styles.caption}>{item.accountLabel} · {formatDate(item.occurredAt)}</Text><Tag tone="green">{item.planOutcome === "PARTIALLY_COMPLETED" ? "Settled · partial request" : "Completed"}</Tag></Card>; }
function TrustJourney({ phase }: { phase: Flow["phase"] }) { const active = phase === "COMPOSE" ? -1 : phase === "CLARIFY" || phase === "WORKING" ? 0 : phase === "MEANING" ? 1 : phase === "PLAN" || phase === "FUNDING" ? 2 : -1; return <View style={styles.journey}>{stages.map((stage, index) => <View key={stage} style={styles.journeyItem}><View style={[styles.journeyDot, index <= active && styles.journeyDotActive]} /><Text style={[styles.journeyText, index === active && styles.journeyTextActive]}>{stage}</Text></View>)}</View>; }
function Conversation({ flow, setFlow, submit, clarify, clarificationAnswer, setClarificationAnswer, confirm, refreshPlan, reviewFunding, fundingReserve, setFundingReserve, state, now, voice, stopVoice, listening, voiceError }: { flow: Flow; setFlow(v: Flow): void; submit(): void; clarify(answer: { selectedCandidateId: string } | { answerText: string }): void; clarificationAnswer: string; setClarificationAnswer(value: string): void; confirm(): void; refreshPlan(): void; reviewFunding(sourceAccountId: string): void; fundingReserve: string; setFundingReserve(value: string): void; state?: BankState; now: number; voice(): void; stopVoice(): void; listening: boolean; voiceError?: string }) {
  if (flow.phase === "COMPOSE") return <><Text style={styles.cardTitle}>What would you like to do?</Text><Text style={styles.body}>Describe one or several actions. Review every detail before anything moves.</Text><TextInput style={[styles.input, styles.multiline]} multiline value={flow.draft} onChangeText={(draft) => setFlow({ ...flow, draft })} placeholder="Send John S$100 and buy one Apple share…" placeholderTextColor={C.muted} accessibilityLabel="Banking request" />{flow.voice && <Text style={styles.caption}>Voice transcript · Edit the text before submitting.</Text>}{voiceError && <Text style={styles.error}>{voiceError}</Text>}<View style={styles.buttonRow}><Btn title={listening ? "Stop listening" : "Use voice"} secondary onPress={listening ? stopVoice : voice} /><Btn title="Review request" disabled={!flow.draft.trim()} onPress={submit} /></View></>;
  if (flow.phase === "WORKING") return <><Text style={styles.cardTitle}>{flow.label}</Text><Text style={styles.body}>Please wait for the server response.</Text></>;
  if (flow.phase === "STOP") return <><Tag tone="red">Safe stop</Tag><Text style={styles.cardTitle}>{flow.title}</Text><Text style={styles.body}>{flow.detail}</Text><Btn title="Start a new request" onPress={() => setFlow({ phase: "COMPOSE", draft: "" })} /></>;
  if (flow.phase === "CLARIFY") { const first: Clarification | undefined = flow.data.clarifications[0]; const typed = !first?.options.length; const question = first?.questionKey === "clarify.transfer.currency" ? "Which currency should we use?" : first?.questionKey === "clarify.transfer.amount" ? "How much should we send?" : first?.questionKey === "clarify.transfer.recipient" ? "Who should receive the money?" : "Which banking record did you mean?"; return <><Tag tone="red">Clarification needed</Tag><Text style={styles.cardTitle}>{question}</Text><Text style={styles.body}>{typed ? "Enter the exact answer. The server will validate it before planning continues." : "Choose the exact option before planning continues."}</Text>{first?.options.map((option) => <Btn key={option.entityId} title={option.displayName} secondary onPress={() => clarify({ selectedCandidateId: option.entityId })} />)}{typed && <><TextInput style={styles.input} value={clarificationAnswer} onChangeText={setClarificationAnswer} placeholder={first?.questionKey === "clarify.transfer.currency" ? "SGD or USD" : first?.questionKey === "clarify.transfer.amount" ? "S$500" : "Your answer"} placeholderTextColor={C.muted} accessibilityLabel="Clarification answer" /><Btn title="Continue" disabled={!clarificationAnswer.trim()} onPress={() => clarify({ answerText: clarificationAnswer.trim() })} /></>}<Btn title="Start over" secondary onPress={() => setFlow({ phase: "COMPOSE", draft: flow.request })} /></>; }
  if (flow.phase === "MEANING") { const candidate = flow.data.status === "AWAITING_BUNDLE_CONFIRMATION" ? flow.data.goalBundleCandidate : flow.data.goalCandidate; return <><Tag tone="red">Meaning confirmation</Tag><Text style={styles.cardTitle}>Is this what you meant?</Text>{describeCandidate(candidate).map((line) => <Text key={line} style={styles.body}>• {line}</Text>)}<Text style={styles.caption}>Confirming meaning creates a goal and plan. It does not move money.</Text><Btn title="Confirm meaning & prepare plan" onPress={confirm} /><Btn title="Edit request" secondary onPress={() => setFlow({ phase: "COMPOSE", draft: flow.request })} /></>; }
  if (flow.phase === "FUNDING") {
    const accounts = state?.accounts.filter((account) => account.status === "ACTIVE" && account.currency === "SGD" && account.capabilities.includes("CONVERT_FX")) ?? [];
    const reserveValid = !fundingReserve.trim() || sgdReserveMinorUnits(fundingReserve) !== undefined;
    return <><Tag tone="red">Funding review</Tag><Text style={styles.cardTitle}>This investment needs more USD</Text><Text style={styles.body}>{flow.detail}</Text><Text style={styles.body}>Choose an eligible SGD account to review a possible conversion. The server will check the current balance and prepare a new meaning confirmation.</Text><TextInput style={styles.input} value={fundingReserve} onChangeText={setFundingReserve} keyboardType="decimal-pad" placeholder="Optional minimum SGD reserve, e.g. 1,000.00" placeholderTextColor={C.muted} accessibilityLabel="Minimum SGD reserve" />{!reserveValid && <Text style={styles.error}>Enter a nonnegative SGD amount with at most two decimal places.</Text>}{accounts.map((account) => <Btn key={account.id} title={`Review funding from ${money("SGD", account.availableMinorUnits)} available`} secondary disabled={!reserveValid} onPress={() => reviewFunding(account.id)} />)}{accounts.length === 0 && <Text style={styles.body}>No eligible SGD funding account is available in the current bank state.</Text>}<Text style={styles.caption}>Reviewing funding does not convert currency or buy the asset.</Text><Btn title="Edit request" secondary onPress={() => setFlow({ phase: "COMPOSE", draft: flow.request })} /></>;
  }
  const plan = flow.review.plan; const expired = !!plan.validity.validUntil && Date.parse(plan.validity.validUntil) <= now; const changed = !!state && state.stateVersion !== plan.bankStateVersion;
  return <><Tag tone={expired || changed ? "red" : "green"}>{expired ? "Quote expired" : changed ? "Bank state changed" : "Plan ready for review"}</Tag><Text style={styles.cardTitle}>Your exact financial plan</Text><Text style={styles.body}>{flow.request}</Text><Text style={styles.caption}>Plan {plan.id} · Bank state {plan.bankStateVersion}</Text>{plan.steps.map((step, index) => <View style={styles.planStep} key={step.id}><Text style={styles.cardTitle}>{index + 1}. {step.action.replaceAll("_", " ")}</Text><Text style={styles.body}>{step.action === "TRANSFER" ? `Recipient: ${state?.beneficiaries.find((p) => p.id === (step.parameters as any).beneficiaryId)?.name ?? "Confirmed recipient"} · ${money((step.parameters as any).amount.currency, (step.parameters as any).amount.minorUnits)}` : step.action === "BUY_ASSET" ? `Asset: ${state?.assets.find((a) => a.id === (step.parameters as any).assetId)?.name ?? "Confirmed asset"} · Total ${money((step.parameters as any).settlementCurrency, (step.parameters as any).authorizedTotalMinor)} including fee ${money((step.parameters as any).settlementCurrency, (step.parameters as any).quotedFeeMinor)}` : step.action === "FX_CONVERT" ? `Convert ${money((step.parameters as any).sourceMoney.currency, (step.parameters as any).sourceMoney.minorUnits)} to ${(step.parameters as any).targetCurrency}` : "Review this server-produced step on the web before authorization."}</Text></View>)}<Text style={styles.caption}>{plan.validity.validUntil ? `Quote valid until ${formatDate(plan.validity.validUntil)}` : "No quote expiry stated"}</Text>{plan.projectedOutcome.projectedAvailableBalances?.map((item) => <Text key={item.accountId} style={styles.body}>Projected {item.accountId}: {money(item.money.currency, item.money.minorUnits)}</Text>)}<Btn title="Refresh plan" secondary onPress={refreshPlan} /><View style={styles.notice}><Text style={styles.cardTitle}>Authorization unavailable on Android</Text><Text style={styles.body}>This app does not request passkey approval or run a transaction. Native passkeys require verified app association and backend support.</Text></View><Btn title="Start new request" secondary onPress={() => setFlow({ phase: "COMPOSE", draft: "" })} /></>;
}

export default function App() { return <SafeAreaProvider><AppContent /></SafeAreaProvider>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg }, center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: C.bg }, signedOut: { flex: 1, padding: 26, gap: 18, justifyContent: "center", backgroundColor: C.bg }, content: { padding: 18, paddingBottom: 34, gap: 12 }, top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingVertical: 14, backgroundColor: C.white, borderBottomWidth: 1, borderColor: C.line }, eyebrow: { color: C.red, fontSize: 11, fontWeight: "800", letterSpacing: 1.8 }, topTitle: { color: C.ink, fontSize: 23, fontWeight: "800", marginTop: 2 }, refresh: { color: C.red, fontSize: 31, paddingHorizontal: 8 }, brand: { color: C.red, fontWeight: "900", fontSize: 24, letterSpacing: 3 }, hero: { fontSize: 27, fontWeight: "800", color: C.ink, lineHeight: 34 }, body: { fontSize: 15, lineHeight: 22, color: C.muted, marginTop: 5 }, card: { backgroundColor: C.white, borderRadius: 18, padding: 18, borderWidth: 1, borderColor: C.line, gap: 5 }, cardTitle: { color: C.ink, fontSize: 16, fontWeight: "700", lineHeight: 22 }, sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 10, marginBottom: 2 }, sectionTitle: { color: C.ink, fontWeight: "800", fontSize: 19 }, sectionAction: { color: C.muted, fontSize: 12 }, balance: { color: C.ink, fontSize: 28, fontWeight: "800", marginVertical: 9 }, balanceSmall: { color: C.ink, fontSize: 20, fontWeight: "800", marginVertical: 5 }, amount: { color: C.ink, fontWeight: "700", fontSize: 14 }, caption: { color: C.muted, fontSize: 12, lineHeight: 18 }, footnote: { color: C.muted, fontSize: 12, lineHeight: 18, marginVertical: 7 }, row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }, button: { backgroundColor: C.red, borderRadius: 12, minHeight: 48, justifyContent: "center", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, marginTop: 10 }, buttonSecondary: { backgroundColor: C.white, borderWidth: 1, borderColor: C.red }, buttonText: { color: C.white, fontWeight: "700", textAlign: "center", fontSize: 14 }, buttonSecondaryText: { color: C.red }, disabled: { opacity: 0.42 }, buttonRow: { flexDirection: "row", gap: 8, alignItems: "stretch" }, quick: { gap: 7 }, tag: { color: C.muted, fontSize: 11, fontWeight: "700", backgroundColor: C.bg, borderRadius: 8, overflow: "hidden", paddingHorizontal: 8, paddingVertical: 5, alignSelf: "flex-start" }, tagRed: { color: C.red, backgroundColor: C.pale }, tagGreen: { color: C.green, backgroundColor: "#eaf7f1" }, input: { backgroundColor: C.white, borderWidth: 1, borderColor: C.line, borderRadius: 12, minHeight: 48, color: C.ink, paddingHorizontal: 14, fontSize: 15 }, multiline: { minHeight: 105, textAlignVertical: "top", paddingVertical: 12, marginTop: 12 }, error: { color: C.red, fontSize: 14, lineHeight: 20 }, notice: { padding: 14, backgroundColor: C.pale, borderRadius: 12, margin: 12 }, nav: { flexDirection: "row", backgroundColor: C.white, borderTopWidth: 1, borderColor: C.line, paddingVertical: 8 }, navItem: { flex: 1, alignItems: "center", minHeight: 48, justifyContent: "center" }, navIcon: { fontSize: 22, color: C.muted }, navLabel: { color: C.muted, fontSize: 10, fontWeight: "600" }, navActive: { color: C.red }, journey: { backgroundColor: C.white, borderRadius: 16, borderWidth: 1, borderColor: C.line, padding: 13, flexDirection: "row", flexWrap: "wrap", gap: 8 }, journeyItem: { width: "47%", flexDirection: "row", alignItems: "center", gap: 7 }, journeyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.line }, journeyDotActive: { backgroundColor: C.red }, journeyText: { color: C.muted, fontSize: 11 }, journeyTextActive: { color: C.ink, fontWeight: "700" }, planStep: { borderTopWidth: 1, borderColor: C.line, paddingVertical: 12 },
});
