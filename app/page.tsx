"use client";

import Image from "next/image";
import Script from "next/script";
import {
  createElement,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const BOX_PRICE = 50000;
const WALLET_PRICE = 48500;
const DEFAULT_ODDS_COPY = "Illustrative odds: 85% Grocery Bundle, 10% Mega Bundle, 5% Tech Prize.";
const DEFAULT_API_TOKEN = "";
const API_BASE_URL =
  process.env.NEXT_PUBLIC_MYSTERY_BOX_API_BASE_URL ?? "https://app.aureliushq.co/api/mystery-box";
const AUTH_REDIRECT_URL = "https://app.aureliushq.co";
const INITIAL_ENTRY_LOADING_MS = 5000;
const REVEAL_COUNTDOWN_STEP_MS = 3000;
const REVEAL_COUNTDOWN_STEPS = 3;
const REVEAL_COUNTDOWN_TOTAL_MS = REVEAL_COUNTDOWN_STEP_MS * REVEAL_COUNTDOWN_STEPS;
const REVEAL_PREPARING_LEAD_MS = 3000;
const REVEAL_SUSPENSE_DELAY_MS = REVEAL_COUNTDOWN_TOTAL_MS + REVEAL_PREPARING_LEAD_MS + 4000;
const OPENING_DURATION_MIN_MS = 5000;
const OPENING_DURATION_RANGE_MS = 3001;
const REVEAL_FLASH_DURATION_MS = 550;
const ERROR_TOAST_DURATION_MS = 4000;

const REVEAL_STATUS_STAGES = [
  { thresholdMs: 0, label: "Reference received", detail: "We found your payment and locked in your entry." },
  { thresholdMs: 3000, label: "Locking your box", detail: "Sealing your Mystery Box before the reveal begins." },
  { thresholdMs: 6000, label: "Shuffling rewards", detail: "Final checks are running before we open the box." },
  { thresholdMs: 9000, label: "Ready to reveal", detail: "Take a breath. The box is about to open." },
] as const;

const GROCERY_BUNDLE_ITEMS = [
  "10kg premium rice",
  "Garri (1 Paint Bucket)",
  "Beans (5kg)",
  "1 carton golden penny noodles",
  "Pieces of spaghetti",
  "Pieces of Tomatoes",
  "Palm Oil/vegetable 2.5ltr",
];

const formatNaira = (amount: number) =>
  `₦${amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

type PaymentMethod = "wallet" | "paystack" | "fincra";
type RewardType = "food" | "iphone";

type Reward = {
  name: string;
  type: RewardType;
};

type PromoConfig = {
  boxes_remaining?: number;
  boxesRemaining?: number;
  iphone_quota?: number;
  iphoneQuota?: number;
  iphone_quota_remaining?: number;
  iphoneQuotaRemaining?: number;
  remaining?: number;
  remaining_count?: number;
  remainingCount?: number;
};

function getSearchParams(): URLSearchParams | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search);
}

function getTokenFromSearchParams(): string {
  return getSearchParams()?.get("mb") ?? getSearchParams()?.get("token") ?? DEFAULT_API_TOKEN;
}

function hasAuthenticationParams(): boolean {
  const searchParams = getSearchParams();
  const reference = searchParams?.get("reference");
  const token = searchParams?.get("mb") ?? searchParams?.get("token") ?? searchParams?.get("reveal_token");

  return Boolean(reference || token);
}

function extractPayload<T>(payload: unknown): T {
  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    (payload as { data?: unknown }).data !== undefined
  ) {
    return (payload as { data: T }).data;
  }

  return payload as T;
}

function resolveOrderId(payload: unknown): number | null {
  const data = extractPayload<Record<string, unknown>>(payload);
  const candidates = [data.order_id, data.orderId, data.id];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function resolveReference(payload: unknown): string | null {
  const data = extractPayload<Record<string, unknown>>(payload);
  const reference = data.reference ?? data.payment_reference ?? data.paymentReference;
  return typeof reference === "string" && reference.length > 0 ? reference : null;
}

function resolvePaymentUrl(payload: unknown): string | null {
  const data = extractPayload<Record<string, unknown>>(payload);
  const candidates = [data.payment_url, data.paymentUrl, data.authorization_url, data.authorizationUrl];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }

  return null;
}

function resolveRevealToken(payload: unknown): string | null {
  const data = extractPayload<Record<string, unknown>>(payload);
  const revealToken = data.reveal_token ?? data.revealToken;
  return typeof revealToken === "string" && revealToken.length > 0 ? revealToken : null;
}

function resolveRemainingCount(payload: unknown): number | null {
  const data = extractPayload<Record<string, unknown>>(payload);
  const candidates = [
    data.boxes_remaining,
    data.boxesRemaining,
    data.iphone_quota_remaining,
    data.iphoneQuotaRemaining,
    data.remaining,
    data.remaining_count,
    data.remainingCount,
    data.iphone_quota,
    data.iphoneQuota,
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function payloadHasRevealResult(payload: unknown): boolean {
  const data = extractPayload<Record<string, unknown>>(payload);
  const rawBundle = data.reward_bundle ?? data.rewardBundle ?? data.items ?? data.rewards;

  return (
    Array.isArray(rawBundle) ||
    "includes_iphone" in data ||
    "includesIphone" in data ||
    typeof resolveRevealToken(payload) === "string"
  );
}

function normalizeRewards(payload: unknown): Reward[] {
  const data = extractPayload<Record<string, unknown>>(payload);
  const rawBundle = data.reward_bundle ?? data.rewardBundle ?? data.items ?? data.rewards;
  const includesIphone = Boolean(data.includes_iphone ?? data.includesIphone);

  if (!Array.isArray(rawBundle)) {
    return includesIphone
      ? [{ name: "iPhone 14 Pro Max", type: "iphone" }]
      : GROCERY_BUNDLE_ITEMS.map((name) => ({ name, type: "food" as const }));
  }

  const normalized = rawBundle
    .map((entry) => {
      if (typeof entry === "string") {
        return {
          name: entry,
          type: /iphone/i.test(entry) ? ("iphone" as const) : ("food" as const),
        };
      }

      if (!entry || typeof entry !== "object") return null;

      const candidate = entry as Record<string, unknown>;
      const name =
        candidate.name ??
        candidate.title ??
        candidate.item_name ??
        candidate.itemName ??
        candidate.product_name ??
        candidate.productName;

      if (typeof name !== "string" || name.length === 0) return null;

      const explicitType =
        candidate.type === "iphone" || candidate.category === "iphone" || /iphone/i.test(name)
          ? "iphone"
          : "food";

      return { name, type: explicitType as RewardType };
    })
    .filter((reward): reward is Reward => reward !== null);

  if (normalized.length > 0) return normalized;

  return includesIphone
    ? [{ name: "iPhone 14 Pro Max", type: "iphone" }]
    : GROCERY_BUNDLE_ITEMS.map((name) => ({ name, type: "food" as const }));
}

async function apiRequest<T>(
  path: string,
  options: {
    token?: string;
    method?: string;
    body?: string;
    query?: Record<string, string | number | null | undefined>;
  } = {},
): Promise<T> {
  const url = new URL(`${API_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.toString(), {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body ? { body: options.body } : {}),
    cache: "no-store",
  });

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload && "message" in payload
        ? String((payload as { message?: string }).message)
        : `Request failed with status ${response.status}`;

    throw new Error(message);
  }

  return payload as T;
}

export default function Home() {
  const [showPrePurchase, setShowPrePurchase] = useState(false);
  const [showPaymentSheet, setShowPaymentSheet] = useState(false);
  const [showPossibleItems, setShowPossibleItems] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showOdds, setShowOdds] = useState(false);
  const [isPageBooting, setIsPageBooting] = useState(true);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("wallet");
  const [authToken] = useState(() => getTokenFromSearchParams());
  const [transactionConfirmed, setTransactionConfirmed] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isRevealLoading, setIsRevealLoading] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [revealCountdown, setRevealCountdown] = useState<number | null>(null);
  const [revealStatusIndex, setRevealStatusIndex] = useState(0);
  const [showRevealFlash, setShowRevealFlash] = useState(false);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [showReveal, setShowReveal] = useState(false);
  const [boxPrice] = useState(BOX_PRICE);
  const [oddsCopy] = useState(DEFAULT_ODDS_COPY);
  const [remainingCount, setRemainingCount] = useState<number | null>(null);
  const [apiMessage, setApiMessage] = useState<string | null>(null);
  const [pendingOrderId, setPendingOrderId] = useState<number | null>(null);
  const [pendingOrderMethod, setPendingOrderMethod] = useState<PaymentMethod | null>(null);
  const [pendingReference, setPendingReference] = useState<string | null>(null);
  const [shareRevealToken, setShareRevealToken] = useState<string | null>(null);
  const [needsGatewayVerification, setNeedsGatewayVerification] = useState(false);
  const suspenseTimeoutRef = useRef<number | null>(null);
  const openingTimeoutRef = useRef<number | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  const errorToastTimeoutRef = useRef<number | null>(null);
  const revealLoadingStartedAtRef = useRef<number | null>(null);
  const entryLoadingTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!authToken) return;

    let isCancelled = false;

    const loadPromoConfig = async () => {
      try {
        const payload = await apiRequest<PromoConfig>("/promo-config", { token: authToken });

        if (isCancelled) return;
        setRemainingCount(resolveRemainingCount(payload));
      } catch {
        if (!isCancelled) {
          setRemainingCount(null);
        }
      }
    };

    void loadPromoConfig();

    return () => {
      isCancelled = true;
    };
  }, [authToken]);

  useEffect(() => {
    const hasRequiredParams = hasAuthenticationParams();

    if (!hasRequiredParams) {
      window.location.replace(AUTH_REDIRECT_URL);
      return;
    }
  }, []);

  const canPay = acceptedTerms && !isProcessing;
  const paymentAmount = paymentMethod === "wallet" ? WALLET_PRICE : boxPrice;
  const iphoneWon = useMemo(
    () => rewards.some((reward) => reward.type === "iphone"),
    [rewards],
  );

  const showErrorToastMessage = useCallback((message: string) => {
    if (errorToastTimeoutRef.current !== null) {
      window.clearTimeout(errorToastTimeoutRef.current);
    }

    setErrorToast(message);

    errorToastTimeoutRef.current = window.setTimeout(() => {
      setErrorToast(null);
    }, ERROR_TOAST_DURATION_MS);
  }, []);

  const showInsufficientWalletToast = useCallback((message: string) => {
    if (!/insufficient wallet balance/i.test(message)) return;
    showErrorToastMessage("Insufficient wallet balance.");
  }, [showErrorToastMessage]);

  const showAddressErrorToast = useCallback((message: string) => {
    if (!/address/i.test(message)) return;
    showErrorToastMessage(message);
  }, [showErrorToastMessage]);

  const showPaymentInitializeFailureToast = useCallback((message: string) => {
    if (/insufficient wallet balance/i.test(message)) {
      showInsufficientWalletToast(message);
      return;
    }

    if (/payment initialization|payment url/i.test(message)) {
      showErrorToastMessage(message);
      return;
    }

    showErrorToastMessage("Unable to initialize payment. Please try again.");
  }, [showErrorToastMessage, showInsufficientWalletToast]);

  useEffect(() => {
    return () => {
      if (suspenseTimeoutRef.current !== null) {
        window.clearTimeout(suspenseTimeoutRef.current);
      }

      if (openingTimeoutRef.current !== null) {
        window.clearTimeout(openingTimeoutRef.current);
      }

      if (flashTimeoutRef.current !== null) {
        window.clearTimeout(flashTimeoutRef.current);
      }

      if (entryLoadingTimeoutRef.current !== null) {
        window.clearTimeout(entryLoadingTimeoutRef.current);
      }

      if (errorToastTimeoutRef.current !== null) {
        window.clearTimeout(errorToastTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    entryLoadingTimeoutRef.current = window.setTimeout(() => {
      setIsPageBooting(false);
    }, INITIAL_ENTRY_LOADING_MS);

    return () => {
      if (entryLoadingTimeoutRef.current !== null) {
        window.clearTimeout(entryLoadingTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isRevealLoading) {
      setRevealCountdown(null);
      setRevealStatusIndex(0);
      revealLoadingStartedAtRef.current = null;
      return;
    }

    const updateRevealSuspense = () => {
      const startedAt = revealLoadingStartedAtRef.current ?? Date.now();
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, REVEAL_SUSPENSE_DELAY_MS - elapsedMs);
      const nextCountdown =
        remainingMs <= REVEAL_COUNTDOWN_TOTAL_MS
          ? Math.max(1, Math.ceil(remainingMs / REVEAL_COUNTDOWN_STEP_MS))
          : null;

      let nextStatusIndex = 0;

      for (let index = 0; index < REVEAL_STATUS_STAGES.length; index += 1) {
        if (elapsedMs >= REVEAL_STATUS_STAGES[index].thresholdMs) {
          nextStatusIndex = index;
        }
      }

      setRevealCountdown(nextCountdown);
      setRevealStatusIndex(nextStatusIndex);
    };

    updateRevealSuspense();

    const intervalId = window.setInterval(updateRevealSuspense, 120);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRevealLoading]);

  const startRevealSequence = useCallback((nextRewards: Reward[]) => {
    if (suspenseTimeoutRef.current !== null) {
      window.clearTimeout(suspenseTimeoutRef.current);
    }

    if (openingTimeoutRef.current !== null) {
      window.clearTimeout(openingTimeoutRef.current);
    }

    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
    }

    setRewards(nextRewards);
    setTransactionConfirmed(true);
    setShowPaymentSheet(false);
    setNeedsGatewayVerification(false);
    setShowReveal(false);
    setShowRevealFlash(false);
    setRevealCountdown(null);
    setRevealStatusIndex(0);
    setIsRevealLoading(true);
    setIsOpening(false);
    revealLoadingStartedAtRef.current = Date.now();

    suspenseTimeoutRef.current = window.setTimeout(() => {
      const openingDurationMs =
        OPENING_DURATION_MIN_MS + Math.floor(Math.random() * OPENING_DURATION_RANGE_MS);

      setIsRevealLoading(false);
      setIsOpening(true);

      openingTimeoutRef.current = window.setTimeout(() => {
        setIsOpening(false);
        setShowRevealFlash(true);
        setShowReveal(true);
        setIsProcessing(false);

        flashTimeoutRef.current = window.setTimeout(() => {
          setShowRevealFlash(false);
        }, REVEAL_FLASH_DURATION_MS);
      }, openingDurationMs);
    }, REVEAL_SUSPENSE_DELAY_MS);
  }, []);

  const createOrder = useCallback(
    async (method: PaymentMethod) => {
      const orderPayload = await apiRequest("/orders", {
        token: authToken,
        method: "POST",
        body: JSON.stringify({
          payment_method: method,
          address_id: 0,
        }),
      });

      const orderId = resolveOrderId(orderPayload);
      if (!orderId) {
        throw new Error("Order was created but no order ID was returned.");
      }

      setPendingOrderId(orderId);
      setPendingOrderMethod(method);
      setPendingReference(null);

      return orderId;
    },
    [authToken],
  );

  const ensureOrderForMethod = useCallback(
    async (method: PaymentMethod) => {
      if (pendingOrderId && pendingOrderMethod === method) {
        return pendingOrderId;
      }

      return createOrder(method);
    },
    [createOrder, pendingOrderId, pendingOrderMethod],
  );

  const initializePaymentForOrder = useCallback(
    async (orderId: number, method: PaymentMethod) => {
      const initializePayload = await apiRequest("/payment/initialize", {
        token: authToken,
        method: "POST",
        body: JSON.stringify({
          order_id: orderId,
          payment_method: method === "wallet" ? null : method,
        }),
      });

      const reference = resolveReference(initializePayload);
      const paymentUrl = resolvePaymentUrl(initializePayload);

      setPendingOrderId(orderId);
      setPendingOrderMethod(method);
      setPendingReference(reference);

      return { reference, paymentUrl };
    },
    [authToken],
  );

  const settlePaidOrder = useCallback(async (orderId: number | null, reference?: string | null) => {
    let revealPayload: unknown = null;
    let resolvedOrderId = orderId;

    if (reference) {
      const verifyPayload = await apiRequest("/payment/verify", {
        token: authToken,
        query: { reference },
      });

      resolvedOrderId = resolveOrderId(verifyPayload) ?? resolvedOrderId;

      if (payloadHasRevealResult(verifyPayload)) {
        setPendingOrderId(resolvedOrderId);
        setPendingReference(reference ?? null);
        setShareRevealToken(resolveRevealToken(verifyPayload));
        startRevealSequence(normalizeRewards(verifyPayload));
        return;
      }
    }

    if (!resolvedOrderId) {
      throw new Error("Payment was verified but no order ID was returned for the reveal result.");
    }

    if (!revealPayload) {
      revealPayload = await apiRequest("/reveal", {
        token: authToken,
        query: { order_id: resolvedOrderId },
      });
    }

    setPendingOrderId(resolvedOrderId);
    setPendingReference(reference ?? null);
    setShareRevealToken(resolveRevealToken(revealPayload));
    startRevealSequence(normalizeRewards(revealPayload));
  }, [authToken, startRevealSequence]);

  const finalizeGatewayOrder = useCallback(
    async (orderId: number | null, reference?: string | null) => {
      if (!reference) {
        throw new Error("Payment reference was not returned for this gateway transaction.");
      }

      const callbackPayload = await apiRequest("/payment/callback", {
        token: authToken,
        query: { reference },
      });

      const callbackOrderId = resolveOrderId(callbackPayload) ?? orderId;

      if (!callbackOrderId) {
        throw new Error("Payment callback completed but no order ID was returned.");
      }

      if (payloadHasRevealResult(callbackPayload)) {
        setPendingOrderId(callbackOrderId);
        setPendingReference(reference);
        setShareRevealToken(resolveRevealToken(callbackPayload));
        startRevealSequence(normalizeRewards(callbackPayload));
        return;
      }

      await settlePaidOrder(callbackOrderId, reference);
    },
    [authToken, settlePaidOrder, startRevealSequence],
  );

  useEffect(() => {
    const searchParams = getSearchParams();
    const revealToken = searchParams?.get("reveal_token");
    const reference = searchParams?.get("reference");
    const orderIdParam = Number(searchParams?.get("order_id"));
    const orderId = Number.isFinite(orderIdParam) ? orderIdParam : null;

    if (!revealToken && !reference) return;

    let isCancelled = false;

    const restorePendingAction = async () => {
      setIsProcessing(true);
      setApiMessage("Restoring your Mystery Box result...");

      try {
        if (revealToken) {
          const revealPayload = await apiRequest("/reveal", {
            token: authToken || undefined,
            query: { reveal_token: revealToken },
          });

          if (isCancelled) return;

          setPendingOrderId(orderId);
          setPendingReference(reference ?? null);
          setShareRevealToken(resolveRevealToken(revealPayload) ?? revealToken);
          startRevealSequence(normalizeRewards(revealPayload));
          return;
        }

        await settlePaidOrder(orderId, reference);
      } catch (error) {
        if (isCancelled) return;
        const errorMessage =
          error instanceof Error ? error.message : "Unable to restore your Mystery Box result.";
        setApiMessage(errorMessage);
        showInsufficientWalletToast(errorMessage);
        setIsProcessing(false);
      }
    };

    void restorePendingAction();

    return () => {
      isCancelled = true;
    };
  }, [authToken, finalizeGatewayOrder, settlePaidOrder, showInsufficientWalletToast, startRevealSequence]);

  const handleStartPurchase = () => {
    if (suspenseTimeoutRef.current !== null) {
      window.clearTimeout(suspenseTimeoutRef.current);
    }

    if (openingTimeoutRef.current !== null) {
      window.clearTimeout(openingTimeoutRef.current);
    }

    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
    }

    setIsRevealLoading(false);
    setIsOpening(false);
    setShowRevealFlash(false);
    setErrorToast(null);
    setShowReveal(false);
    setRewards([]);
    setTransactionConfirmed(false);
    setAcceptedTerms(false);
    setApiMessage(null);
    setPendingOrderId(null);
    setPendingOrderMethod(null);
    setPendingReference(null);
    setShareRevealToken(null);
    setNeedsGatewayVerification(false);
    setShowPrePurchase(true);
  };

  const handleProceedToPayment = async () => {
    if (!canPay) return;

    setIsProcessing(true);
    setApiMessage(null);

    try {
      const orderId = await ensureOrderForMethod(paymentMethod);
      setShowPrePurchase(false);

      if (paymentMethod === "wallet") {
        const { reference } = await initializePaymentForOrder(orderId, "wallet");
        await settlePaidOrder(orderId, reference);
        return;
      }

      setShowPaymentSheet(true);
      setApiMessage("Order created. Click below to initialize your payment gateway.");
      setIsProcessing(false);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unable to create your Mystery Box order.";
      setApiMessage(errorMessage);
      showInsufficientWalletToast(errorMessage);
      showAddressErrorToast(errorMessage);
      setIsProcessing(false);
    }
  };

  const handleConfirmTransaction = async () => {
    setIsProcessing(true);
    setApiMessage(null);

    try {
      if (needsGatewayVerification && pendingOrderId) {
        await finalizeGatewayOrder(pendingOrderId, pendingReference);
        return;
      }

      const orderId = await ensureOrderForMethod(paymentMethod);
      const { paymentUrl } = await initializePaymentForOrder(orderId, paymentMethod);

      if (!paymentUrl) {
        throw new Error("Payment initialization succeeded but no payment URL was returned.");
      }

      setNeedsGatewayVerification(true);
      window.location.assign(paymentUrl);
      return;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unable to process Mystery Box purchase.";
      setApiMessage(errorMessage);
      if (needsGatewayVerification) {
        showErrorToastMessage(errorMessage);
      } else {
        showPaymentInitializeFailureToast(errorMessage);
      }
      setIsProcessing(false);
    }
  };

  const handleShareWhatsApp = () => {
    const shareUrl = shareRevealToken
      ? `${window.location.origin}/r/${encodeURIComponent(shareRevealToken)}`
      : null;
    const message = shareUrl
      ? `Just opened my Aurelius Mystery Box! 🎁 and it was totally worth it. 🥘 Since you like good deals, you should check out their Mystery Box, they’re giving away iPhones 14 Pro Max too! Try it: ${shareUrl}`
      : "Just opened my Aurelius Mystery Box! 🎁 and it was totally worth it. 🥘 Since you like good deals, you should check out their Mystery Box, they’re giving away iPhones 14 Pro Max too!";
    const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleCloseReveal = () => {
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
    }

    setShowRevealFlash(false);
    setErrorToast(null);
    setShowReveal(false);
    setRewards([]);
    setTransactionConfirmed(false);
    setAcceptedTerms(false);
    setApiMessage(null);
    setPendingOrderId(null);
    setPendingOrderMethod(null);
    setPendingReference(null);
    setShareRevealToken(null);
    setNeedsGatewayVerification(false);
  };

  return (
    <main className="min-h-screen bg-[#0b1220] px-4 py-10 text-white">
      <Script
        src="https://unpkg.com/@lottiefiles/lottie-player@latest/dist/lottie-player.js"
        strategy="afterInteractive"
      />
      {errorToast ? (
        <section className="fixed inset-x-0 top-4 z-[70] flex justify-center px-4">
          <div className="w-full max-w-sm rounded-2xl border border-[#fca5a5] bg-[#7f1d1d]/95 px-4 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-20px_rgba(248,113,113,0.9)] backdrop-blur">
            {errorToast}
          </div>
        </section>
      ) : null}
      {isPageBooting ? (
        <section className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-[#030712] px-6 text-center text-[#fff9ef]">
          <div className="flex h-28 w-28 items-center justify-center rounded-[2rem] border border-white/15 bg-white/5 text-5xl shadow-[0_0_80px_rgba(251,146,60,0.18)]">
            🎁
          </div>
          <div className="h-14 w-14 animate-spin rounded-full border-4 border-white/15 border-t-[#fb923c]" />
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.32em] text-[#93c5fd]">Loading experience</p>
            <h1 className="text-2xl font-bold text-[#fb923c]">Preparing your Mystery Box</h1>
            <p className="max-w-sm text-sm text-[#f9f2e3]">
              One moment while we stage the full reveal flow before the page appears.
            </p>
          </div>
        </section>
      ) : null}
      <section className="mx-auto max-w-md rounded-[28px] border border-white/15 bg-[#111827] p-6 shadow-[0_30px_70px_-35px_rgba(0,0,0,0.9)]">
        <div className="mb-5 flex items-center justify-between">
          <p className="text-xs font-medium tracking-[0.2em] text-[#93c5fd]">AURELIUS</p>
          <span className="rounded-full border border-[#1d4ed8] bg-[#0f172a] px-3 py-1 text-xs text-[#bfdbfe]">
            Promo
          </span>
        </div>

        <div className="rounded-3xl border border-white/15 bg-[#1e3a8a] p-5">
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#bfdbfe]">
              Limited Offer
            </p>
            <h1 className="mt-2 text-2xl md:text-[2rem] font-extrabold tracking-tight text-white">🎁 Mystery Box</h1>
            <p className="mx-auto mt-3 max-w-xs text-base leading-6 text-[#dfe9ff]">
              Unlock one premium reward path: essential foodstuffs or an iPhone 14 Pro Max.
            </p>
            {remainingCount !== null ? (
              <p className="mt-3 text-sm font-semibold text-[#fde68a]">
                Boxes remaining: {remainingCount}
              </p>
            ) : null}
          </div>

          <div className="mt-6">
            <button
              type="button"
              onClick={handleStartPurchase}
              className="relative block w-full overflow-hidden rounded-2xl border border-white/20 bg-white p-2 text-left"
            >
              <Image
                src="/mystery-box-package.jpg"
                alt="Mystery box basket with groceries and iPhone"
                width={1024}
                height={1024}
                className="h-56 w-full rounded-xl object-cover sm:h-60"
                priority
              />
              <div className="absolute bottom-4 right-4 rounded-2xl border border-[#fb923c]/80 bg-[#111827]/95 px-4 py-3 text-center shadow-lg">
                <p className="text-xs uppercase tracking-wide text-[#d9e5ff]">Only</p>
                <p className="text-2xl font-extrabold text-[#fb923c]">{formatNaira(boxPrice)}</p>
                <p className="text-xs uppercase tracking-wide text-[#d9e5ff]">per box</p>
              </div>
            </button>

     
          </div>
        </div>

        <button
          type="button"
          onClick={handleStartPurchase}
          className="mt-6 w-full rounded-2xl bg-[#f97316] px-4 py-3 text-lg font-extrabold text-white transition hover:bg-[#ea580c]"
        >
          Buy & Open
        </button>

        <button
          type="button"
          onClick={() => setShowPossibleItems(true)}
          className="mt-4 w-full text-center text-sm text-[#cbd5e1] underline underline-offset-2"
        >
          View Possible Items & Probabilities
        </button>
      </section>

      {showPossibleItems ? (
        <section className="fixed inset-0 z-20 flex items-end justify-center bg-black/80 p-4 sm:items-center">
          <div className="w-full max-w-md rounded-[24px] border border-white/20 bg-[#0f172a] p-4 text-white shadow-[0_30px_70px_-35px_rgba(0,0,0,0.7)]">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold">Possible Mystery Package 📦</h2>
              <button
                type="button"
                onClick={() => setShowPossibleItems(false)}
                className="rounded-lg border border-white/20 px-2 py-1 text-xs font-semibold"
              >
                ← Back
              </button>
            </div>

            <div className="overflow-hidden rounded-2xl border border-white/20 bg-white p-2">
              <Image
                src="/mystery-box-package.jpg"
                alt="Package with basmati rice, spaghetti, noodles, cooking oil and iPhone 14 Pro Max"
                width={1024}
                height={1024}
                className="h-52 w-full rounded-xl object-cover sm:h-56"
              />
            </div>

            <p className="mt-3 text-sm leading-6 text-[#dbeafe]">
              Premium groceries guaranteed or a rare Grand Prize. Each box unlocks one reward path
              only: either essential foodstuffs like Rice, Spaghetti, noodles, frozen chicken,
              cooking oil and more, or an iPhone 14 Pro Max.
            </p>
          </div>
        </section>
      ) : null}

      {showPrePurchase ? (
        <section className="fixed inset-0 z-20 flex items-end justify-center bg-[#09194f]/70 p-4 backdrop-blur-sm sm:items-center">
          <div className="w-full max-w-md rounded-[26px] border border-white/70 bg-[#fbfcff] p-6 text-[#1d2336] shadow-[0_30px_70px_-35px_rgba(0,0,0,0.5)]">
            <button
              type="button"
              onClick={() => setShowPrePurchase(false)}
              className="mb-3 rounded-lg border border-[#c8d0e8] px-3 py-1 text-xs font-semibold text-[#3b4c75]"
            >
              ← Back
            </button>
            <h2 className="text-center text-2xl font-bold text-[#12172a]">Ready to Try Your Luck?</h2>
            <p className="mt-3 text-center text-base leading-6 text-[#3c4663]">
              Each Mystery Box unlocks one reward path only: premium foodstuffs or, for four lucky
              participants, an iPhone 14 Pro Max.
            </p>

            <div className="mx-auto mt-5 w-fit rounded-full bg-[#f97316] px-6 py-2 text-base font-bold text-white">
              Price: {formatNaira(boxPrice)}
            </div>
            {remainingCount !== null ? (
              <p className="mt-3 text-center text-sm font-semibold text-[#92400e]">
                Boxes remaining: {remainingCount}
              </p>
            ) : null}

            <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-[#334155]">
              Choose Payment Route
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setPaymentMethod("wallet")}
                className={`rounded-xl px-3 py-2.5 text-sm font-semibold ${
                  paymentMethod === "wallet"
                    ? "bg-[#f97316] text-white"
                    : "bg-[#eef2ff] text-[#203574]"
                }`}
              >
                Aurelius Wallet ({formatNaira(WALLET_PRICE)})
              </button>
              <button
                type="button"
                onClick={() => setPaymentMethod("paystack")}
                className={`rounded-xl px-3 py-2.5 text-sm font-semibold ${
                  paymentMethod !== "wallet"
                    ? "bg-[#2563eb] text-white"
                    : "bg-[#eef2ff] text-[#203574]"
                }`}
              >
                Other Payments
              </button>
            </div>

            <button
              type="button"
              onClick={() => setShowOdds((current) => !current)}
              className="mt-4 text-sm font-semibold text-[#1d4ed8] underline"
            >
              {showOdds ? "Hide Odds" : "View Odds"}
            </button>
            {showOdds ? (
              <p className="mt-2 rounded-xl bg-[#eff6ff] p-3 text-xs text-[#1e3a8a]">
                {oddsCopy}
              </p>
            ) : null}

            {apiMessage ? (
              <p className="mt-3 rounded-xl bg-[#fff7ed] p-3 text-xs leading-5 text-[#9a3412]">
                {apiMessage}
              </p>
            ) : null}

            <label className="mt-4 flex items-start gap-2 text-sm text-[#2f4b7f]">
              <input
                type="checkbox"
                checked={acceptedTerms}
                onChange={(event) => setAcceptedTerms(event.target.checked)}
                className="mt-1 h-5 w-5 accent-[#f97316]"
              />
              <span>
                I agree to{" "}
                <button
                  type="button"
                  onClick={() => setShowTerms(true)}
                  className="font-semibold text-[#1d4ed8] underline"
                >
                  Terms & Conditions
                </button>
              </span>
            </label>

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowPrePurchase(false)}
                className="w-full rounded-xl border border-[#c8d0e8] px-4 py-3 text-sm font-semibold text-[#3b4c75]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleProceedToPayment}
                disabled={!canPay}
                className="w-full rounded-xl bg-[#f97316] px-4 py-3 text-sm font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                Pay & Open Now
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {showPaymentSheet ? (
        <section className="fixed inset-0 z-30 flex items-end justify-center bg-[#09194f]/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-[26px] border border-white/15 bg-[#0f172a] p-6 text-[#ebf1ff] shadow-[0_-20px_50px_-20px_rgba(0,0,0,0.8)]">
            <button
              type="button"
              onClick={() => {
                if (isProcessing) return;
                setShowPaymentSheet(false);
                setShowPrePurchase(true);
              }}
              disabled={isProcessing}
              className="mb-3 rounded-lg border border-white/20 px-3 py-1 text-xs font-semibold disabled:opacity-50"
            >
              ← Back
            </button>
            <h2 className="text-2xl font-bold text-[#fb923c]">Confirm Transaction</h2>
            <p className="mt-3 text-sm leading-6 text-[#d9e4ff]">
              Select your preferred secure payment gateway to complete your Mystery Box purchase.
              Once Payment confirmed, you can open your box immediately.
            </p>

            <div className="mt-5 space-y-2">
              <label className="flex cursor-pointer items-center justify-between rounded-xl border border-white/20 bg-white/5 p-3 text-sm">
                <span>
                  Paystack / Card <span className="text-[#93c5fd]">(Full: {formatNaira(boxPrice)})</span>
                </span>
                <input
                  type="radio"
                  name="paymentMethod"
                  checked={paymentMethod === "paystack"}
                  onChange={() => setPaymentMethod("paystack")}
                  className="accent-[#f97316]"
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between rounded-xl border border-white/20 bg-white/5 p-3 text-sm">
                <span>
                  Fincra <span className="text-[#93c5fd]">(Full: {formatNaira(boxPrice)})</span>
                </span>
                <input
                  type="radio"
                  name="paymentMethod"
                  checked={paymentMethod === "fincra"}
                  onChange={() => setPaymentMethod("fincra")}
                  className="accent-[#f97316]"
                />
              </label>
            </div>

            <div className="mt-4 rounded-xl bg-[#1e3a8a] p-3 text-sm text-[#dbe6ff]">
              <p>Amount: {formatNaira(paymentAmount)}</p>
              <p className="mt-1">Method: {paymentMethod.toUpperCase()}</p>
              <p className="mt-1">
                Status:{" "}
                {transactionConfirmed
                  ? "Verified"
                  : needsGatewayVerification
                    ? "Awaiting Verification"
                    : "Awaiting Confirmation"}
              </p>
            </div>

            {apiMessage ? (
              <p className="mt-3 rounded-xl bg-[#172554] p-3 text-xs leading-5 text-[#dbeafe]">
                {apiMessage}
              </p>
            ) : null}

            <button
              type="button"
              onClick={handleConfirmTransaction}
              disabled={isProcessing}
              className="mt-5 w-full rounded-xl bg-[#f97316] px-4 py-3 text-sm font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isProcessing
                ? "Processing..."
                : needsGatewayVerification
                  ? "I've Paid, Verify & Open"
                  : "Go to Checkout"}
            </button>
          </div>
        </section>
      ) : null}

      {isRevealLoading ? (
        <section className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-[#030712]/95 px-6 text-center text-[#fff9ef]">
          <div
            className={`flex h-28 w-28 items-center justify-center rounded-[2rem] border border-white/15 bg-white/5 text-5xl shadow-[0_0_80px_rgba(251,146,60,0.18)] ${
              revealCountdown !== null ? "reveal-suspense-shake" : ""
            }`}
          >
            🎁
          </div>
          <div className="h-14 w-14 animate-spin rounded-full border-4 border-white/15 border-t-[#fb923c]" />
          <div className="space-y-2">
            <h2 className="text-2xl font-bold text-[#fb923c]">
              {REVEAL_STATUS_STAGES[revealStatusIndex].label}
            </h2>
            <p className="max-w-sm text-sm text-[#f9f2e3]">
              {REVEAL_STATUS_STAGES[revealStatusIndex].detail}
            </p>
            {revealCountdown !== null ? (
              <p className="pt-2 text-4xl font-black tracking-[0.2em] text-white">{revealCountdown}</p>
            ) : (
              <p className="pt-2 text-xs uppercase tracking-[0.3em] text-[#fda4af]">
                Preparing the opening sequence
              </p>
            )}
          </div>
        </section>
      ) : null}

      {isOpening ? (
        <section className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-[#030712]/95 text-center text-[#fff9ef]">
          {createElement("lottie-player", {
            src: "/giftbox.json",
            background: "transparent",
            speed: "1",
            style: { width: "220px", height: "220px" },
            autoplay: true,
          })}
          <h2 className="text-2xl font-bold text-[#fb923c]">Opening Your Mystery Box...</h2>
          <p className="max-w-sm text-sm text-[#f9f2e3]">
            Your reward path is being selected now. You&apos;ll unlock either a premium grocery bundle
            or the iPhone 14 Pro Max grand prize.
          </p>
          <p className="text-xs text-[#9ca3af]">Payment confirmed. This step can’t be reversed.</p>
        </section>
      ) : null}

      {showReveal ? (
        <section className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-3">
          <div className="relative min-h-[80vh] w-full max-w-md overflow-hidden rounded-[24px] border border-white/15 bg-[#1e3a8a] p-4 text-white shadow-[0_25px_80px_-35px_rgba(0,0,0,0.95)]">
            {showRevealFlash ? <div className="reveal-flash-overlay pointer-events-none absolute inset-0 z-10" /> : null}
            <button
              type="button"
              onClick={handleCloseReveal}
              className="relative z-20 mb-1 rounded-lg border border-white/25 px-2.5 py-1 text-[11px] font-semibold"
            >
              ← Back to Home
            </button>
            <div className="pointer-events-none absolute inset-0 z-10">
              {Array.from({ length: 22 }).map((_, index) => (
                <span
                  // Intentional inline style for random confetti distribution.
                  key={`confetti-${index}`}
                  className="confetti-piece"
                  style={
                    {
                      left: `${(index * 4.5) % 100}%`,
                      animationDelay: `${(index % 7) * 0.16}s`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>

            <h2 className="relative z-20 text-2xl font-extrabold text-[#fb923c]">
              Congratulations! 
            </h2>
            <p className="relative z-20 mt-1 text-sm font-semibold text-[#e6eeff]">
              You opened a Mystery Box!
            </p>

            <div className="relative z-20 mt-5 grid gap-3">
              {iphoneWon ? (
                <article className="overflow-hidden rounded-2xl border border-[#fb923c] bg-[#fff7ed] p-3 text-[#2f3444] shadow-[0_20px_35px_-20px_rgba(251,146,60,0.8)]">
                  <p className="text-[11px] font-semibold uppercase tracking-wider">Grand Prize Visual</p>
                  <div className="mt-1.5 overflow-hidden rounded-xl border border-[#fed7aa] bg-white">
                    <Image
                      src="/iphone-14-pro-max.jpg"
                      alt="iPhone 14 Pro Max prize"
                      width={1024}
                      height={1024}
                      className="h-36 w-full object-cover object-center"
                    />
                  </div>
                  <p className="mt-1.5 text-xs font-bold">iPhone 14 Pro Max</p>
                  <p className="text-[11px] text-[#4b5563]">Storage options: 128GB and 256GB</p>
                  <p className="text-[11px] text-[#4b5563]">
                    Color options: Deep purple, black, white
                  </p>
                </article>
              ) : null}

              {!iphoneWon ? (
                <article className="overflow-hidden rounded-2xl border border-white/20 bg-white p-3 text-[#2f3444]">
                  <p className="text-[11px] font-semibold uppercase tracking-wider">Premium Grocery Bundle</p>
                  <div className="mt-1.5 overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <Image
                      src="/grocery-bundle.jpg"
                      alt="Premium grocery bundle prize"
                      width={1280}
                      height={752}
                      className="h-32 w-full object-cover object-center"
                    />
                  </div>
                  <ul className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-[#374151]">
                    {rewards.map((reward) => (
                      <li
                        key={reward.name}
                        className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 leading-tight"
                      >
                        {reward.name}
                      </li>
                    ))}
                  </ul>
                </article>
              ) : null}
            </div>

            {iphoneWon ? (
              <div className="relative z-20 mt-5 rounded-2xl border border-[#fb923c]/25 bg-[#111827]/70 p-3 text-xs text-[#e9efff]">
                <p>
                  Jackpot unlocked. You won the iPhone 14 Pro Max grand prize! Share your win to
                  WhatsApp or record an unboxing video to earn ₦1,000 credit. Credits are valid for
                  20 days.
                </p>
              </div>
            ) : (
              <div className="relative z-20 mt-5 rounded-2xl border border-[#fb923c]/25 bg-[#111827]/70 p-3 text-xs text-[#e9efff]">
                <p>
                  You&apos;ve unlocked a premium selection of essentials with 100% free delivery! To
                  get ₦1,000 credit, share your win to WhatsApp or record an unboxing video. Credits
                  are valid for 20 days. Thank you for choosing Aurelius for your premium essentials!
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={handleShareWhatsApp}
              className="relative mt-5 w-full rounded-2xl bg-[#1faf5e] px-4 py-2.5 text-sm font-bold text-white"
            >
              Share your wins to WhatsApp
            </button>

            <p className="mt-2 text-center text-xs text-[#ebf1ff]">Delivery within 24-72 hours</p>
          </div>
        </section>
      ) : null}

      <section className="mx-auto mt-8 max-w-md rounded-2xl border border-[#fb923c]/30 bg-[#111827] p-4 text-xs leading-relaxed text-[#dbeafe]">
        Each Mystery Box contains guaranteed foodstuffs. The iPhone 14 Pro Max is a limited
        promotional prize. Lucky users are selected randomly. Participation does not guarantee
        winning the iPhone. Price per box is final. By purchasing, you agree to Aurelius&apos;{" "}
        <button
          type="button"
          onClick={() => setShowTerms(true)}
          className="font-semibold text-[#fb923c] underline"
        >
          Terms & Conditions
        </button>
        .
      </section>

      {showTerms ? (
        <section className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-4 sm:items-center">
          <div className="w-full max-w-2xl rounded-2xl border border-[#fb923c]/40 bg-[#0f172a] p-5 text-[#e2e8f0] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-white">
                  Aurelius Mystery Box: Terms and Conditions
                </h2>
                <p className="mt-1 text-sm text-[#94a3b8]">Effective Date: March 2026</p>
              </div>
              <button
                type="button"
                onClick={() => setShowTerms(false)}
                className="rounded-lg border border-white/20 px-3 py-1 text-sm font-semibold"
              >
                ← Back
              </button>
            </div>

            <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1 text-sm leading-6">
              <div>
                <h3 className="font-semibold text-[#fb923c]">1. Nature of the Service</h3>
                <p>
                  By purchasing the Aurelius Mystery Box, you (the &quot;User&quot;) acknowledge that
                  you are purchasing a blind-selection bundle of physical goods.
                </p>
                <p>The Purchase: Each box costs a fixed price of ₦50,000.</p>
                <p>
                  Guaranteed Value: Every box is guaranteed to contain essential foodstuffs
                  (groceries) with a combined retail value equivalent to or exceeding the purchase
                  price.
                </p>
                <p>
                  The Surprise: The specific items are randomized and revealed only after the
                  digital &quot;unboxing&quot; animation in the app.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-[#fb923c]">2. Promotional Prize (iPhone 14 Pro Max)</h3>
                <p>Lucky Draw: The iPhone 14 Pro Max is a limited promotional prize.</p>
                <p>
                  Probability: Buying a box does not guarantee winning an iPhone. Winners are
                  selected via a secure, automated Random Number Generator (RNG) at the moment of
                  the digital &quot;opening.&quot;
                </p>
                <p>
                  Availability: Only 4 number of iPhones are available per promotional cycle. Once
                  the limit is reached, the prize is removed from the pool until the next cycle.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-[#fb923c]">3. Payments and Wallet</h3>
                <p>
                  Outright Purchase: Mystery Boxes can only be purchased via the Aurelius Wallet or
                  integrated payment gateways (Paystack/Fincra).
                </p>
                <p>
                  Finality: Once the &quot;Pay & Open&quot; button is clicked and payment is confirmed, the
                  transaction is final. You cannot cancel the order once the digital reveal has
                  started.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-[#fb923c]">4. Delivery and Fulfillment</h3>
                <p>
                  Timeline: Physical items (Foodstuffs and/or iPhone) will be dispatched within
                  24–72 hours for major cities (Lagos, Abuja, Kano, PH, Kogi) and up to 5 business
                  days for other regions.
                </p>
                <p>
                  Verification: For High-value prizes (e.g., iPhone 14 Pro Max) will only be issued
                  to users who have completed their Account Activation KYC (NIN/Government ID
                  verified) on the Aurelius platform.
                </p>
                <p>
                  The prize will be registered and shipped strictly to the name and address
                  associated with the verified Aurelius account. Prizes are non-transferable to
                  third parties.
                </p>
                <p>Shipping Fees: Delivery fees is inclusive and calculated at checkout.</p>
                <p>
                  Coverage Area: Free delivery applies to all major cities within Nigeria. Aurelius
                  reserves the right to request a &quot;surcharge&quot; or redirect the parcel to the nearest
                  logistics hub for extremely remote/inaccessible locations.
                </p>
                <p>
                  Address Accuracy: Prizes will be sent to the address provided in your user
                  profile. If a delivery fails due to an incorrect address provided by the user, the
                  user may be liable for the cost of the second delivery attempt.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-[#fb923c]">5. No-Return & Refund Policy</h3>
                <p>
                  Surprise Element: Due to the nature of mystery box sales, returns or exchanges
                  based on &quot;dislike&quot; of contents are strictly prohibited.
                </p>
                <p>
                  Damaged Goods: If items are received in a damaged or expired state, the User must
                  contact Aurelius Support with video/photo evidence within 12 hours of delivery for
                  a replacement.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-[#fb923c]">6. Limitation of Liability</h3>
                <p>Aurelius is not responsible for:</p>
                <p>
                  Network or internet failure during the &quot;opening&quot; animation. (In case of a crash,
                  the items assigned to you will be visible in your Order History).
                </p>
                <p>
                  Health issues arising from food allergies (Users should check labels on items
                  received).
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-[#fb923c]">7. Legal Compliance</h3>
                <p>
                  This mystery box is a promotional sale of goods and is not a lottery. It is
                  governed by the laws of the Federal Republic of Nigeria. Aurelius reserves the
                  right to modify or end the promotion at any time.
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
