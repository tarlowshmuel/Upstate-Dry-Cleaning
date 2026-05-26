import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";

const BUSINESS_NAME = "Upstate Dry Cleaning";
const SERVICE_AREA = "Sullivan County, NY";
const SHORT_CODE_DISPLAY = "(845) 606-0022";
const SMS_NUMBER_HREF = "+18456060022";
const CONTACT_EMAIL = "upstatedrycleaning@gmail.com";

export default function Sms() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <header className="mb-8 flex items-center gap-4">
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt={BUSINESS_NAME}
            className="h-20 w-20 rounded-full object-cover shadow-sm border border-border/40 shrink-0"
          />
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {BUSINESS_NAME}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              SMS-based dry cleaning pickup &amp; delivery in {SERVICE_AREA}
            </p>
          </div>
        </header>

        {/* ─────────── HERO / OPT-IN CTA ─────────── */}
        <Card className="mb-8 border-primary/30">
          <CardHeader>
            <CardTitle className="text-2xl">
              Sign up for pickup &amp; delivery
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 text-sm leading-relaxed">
            <p className="text-base">
              To schedule a dry cleaning pickup, send a text message to{" "}
              <a
                href={`sms:${SMS_NUMBER_HREF}`}
                className="font-semibold text-primary underline underline-offset-4"
              >
                {SHORT_CODE_DISPLAY}
              </a>{" "}
              with the word{" "}
              <span className="font-mono bg-muted px-1.5 py-0.5 rounded">
                clean
              </span>
              . We will reply with a short series of questions (name, address,
              gate code if any, and pickup day) to set up your order.
            </p>

            <div className="rounded-md border border-border bg-muted/40 p-4 space-y-2">
              <p className="font-semibold">How to opt in (step by step):</p>
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  From your mobile phone, text the word{" "}
                  <span className="font-mono">clean</span> to{" "}
                  <span className="font-mono">{SHORT_CODE_DISPLAY}</span>.
                </li>
                <li>
                  Reply to our automated questions to confirm your name, colony,
                  unit number, gate code (if any), and pickup date.
                </li>
                <li>
                  Once your first pickup request is confirmed, you are opted in
                  to receive SMS order updates from {BUSINESS_NAME}.
                </li>
              </ol>
              <p className="text-xs text-muted-foreground pt-1">
                By texting us, you expressly consent to receive SMS messages from{" "}
                {BUSINESS_NAME} related to your dry cleaning orders. Consent is{" "}
                <span className="font-medium">not</span> a condition of purchase.
              </p>
            </div>

            <div className="rounded-md border border-border bg-background p-4">
              <p className="font-semibold mb-2">Sample message you will receive:</p>
              <div className="font-mono text-xs whitespace-pre-wrap bg-muted/60 p-3 rounded border border-border/60">
                {`Hi Sarah — this is ${BUSINESS_NAME}. Your pickup is confirmed for Monday 6/1 at 128 Brickman Rd, Bungalow 14. Reply STOP to unsubscribe, HELP for help. Msg & data rates may apply.`}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ─────────── PROGRAM DETAILS (matches Twilio CTA checklist) ─────────── */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="text-xl">SMS program details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm leading-relaxed">
            <ul className="space-y-3">
              <li>
                <span className="font-semibold">Program name:</span>{" "}
                {BUSINESS_NAME} Pickup Notifications
              </li>
              <li>
                <span className="font-semibold">Description:</span>{" "}
                Transactional SMS notifications about scheduled dry cleaning
                pickups and deliveries. You will receive order confirmation,
                pickup confirmation, ready-for-delivery, and delivery
                notifications. This is not a marketing program.
              </li>
              <li>
                <span className="font-semibold">Message frequency:</span>{" "}
                Message frequency varies based on your order activity.
                Typically 2–6 messages per pickup cycle.
              </li>
              <li>
                <span className="font-semibold">
                  Message and data rates may apply.
                </span>{" "}
                Standard messaging and data rates from your wireless carrier
                may apply to each message sent or received.
              </li>
              <li>
                <span className="font-semibold">Opt-in keyword:</span>{" "}
                Text <span className="font-mono">clean</span> (or any pickup
                request) to{" "}
                <span className="font-mono">{SHORT_CODE_DISPLAY}</span> to begin
                service and consent to SMS updates.
              </li>
              <li>
                <span className="font-semibold">Opt-out keyword:</span> Reply{" "}
                <span className="font-mono">STOP</span> to any message to
                unsubscribe at any time. You will receive a one-time
                confirmation that you have been unsubscribed and no further
                messages will be sent.
              </li>
              <li>
                <span className="font-semibold">Help keyword:</span> Reply{" "}
                <span className="font-mono">HELP</span> for assistance, or
                contact us at{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-primary underline underline-offset-4"
                >
                  {CONTACT_EMAIL}
                </a>
                .
              </li>
              <li>
                <span className="font-semibold">Supported carriers:</span>{" "}
                Compatible with all major U.S. carriers. Carriers are not
                liable for delayed or undelivered messages.
              </li>
            </ul>

            <div className="rounded-md border border-border bg-muted/40 p-4 text-xs space-y-1">
              <p className="font-semibold">Privacy:</p>
              <p>
                {BUSINESS_NAME} does not sell, rent, share, or otherwise
                disclose your mobile phone number or SMS opt-in data to any
                third parties or affiliates for marketing or promotional
                purposes. Mobile information is used only to operate the
                service you requested. See our{" "}
                <Link
                  href="/privacy"
                  className="text-primary underline underline-offset-4"
                >
                  Privacy Policy
                </Link>{" "}
                and{" "}
                <Link
                  href="/terms"
                  className="text-primary underline underline-offset-4"
                >
                  Terms of Service
                </Link>{" "}
                for full details.
              </p>
            </div>
          </CardContent>
        </Card>

        <footer className="mt-8 text-center text-xs text-muted-foreground space-y-1">
          <p>
            <Link href="/privacy" className="underline underline-offset-4">
              Privacy Policy
            </Link>
            {" · "}
            <Link href="/terms" className="underline underline-offset-4">
              Terms of Service
            </Link>
          </p>
          <p>
            &copy; {new Date().getFullYear()} {BUSINESS_NAME}. All rights
            reserved.
          </p>
        </footer>
      </div>
    </div>
  );
}
