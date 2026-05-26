import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const BUSINESS_NAME = "Upstate Dry Cleaning";
const SERVICE_AREA = "Sullivan County, NY";
const CONTACT_EMAIL = "upstatedrycleaning@gmail.com";
const CONTACT_PHONE = "(845) 606-0022";
const LAST_UPDATED = "May 26, 2026";
const REFERRAL_THRESHOLD = 3;
const REFERRAL_CREDIT_USD = 30;
const REFERRAL_MAX_REDEMPTIONS = 2;

export default function Legal() {
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
            <h1 className="text-3xl font-bold tracking-tight">Privacy Policy &amp; Terms of Service</h1>
            <p className="text-sm text-muted-foreground mt-2">
              {BUSINESS_NAME} &middot; Last updated {LAST_UPDATED}
            </p>
          </div>
        </header>

        {/* ─────────────── PRIVACY POLICY ─────────────── */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="text-2xl">Privacy Policy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 text-sm leading-relaxed">
            <section>
              <h2 className="font-semibold text-base mb-2">1. Information we collect</h2>
              <p>
                When you use {BUSINESS_NAME} to schedule a dry cleaning pickup, we
                collect the information you provide by SMS, including: your name,
                mobile phone number, pickup address (colony, unit number, and gate
                code if applicable), and the requested pickup date.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">2. How we use your information</h2>
              <p>
                We use your information solely to schedule, pick up, clean, and
                return your laundry, and to send you SMS updates about the status of
                your order (e.g., when your order has been picked up or delivered
                back to your unit).
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">
                3. No sharing of mobile information
              </h2>
              <p className="font-medium">
                {BUSINESS_NAME} does not sell, rent, share, or otherwise disclose
                your mobile phone number or SMS opt-in data to any third parties or
                affiliates for marketing or promotional purposes. Mobile information
                is used only to operate the service you requested.
              </p>
              <p className="mt-2">
                We do not share mobile opt-in consent or phone numbers with third
                parties. Aggregate, anonymized data that does not identify any
                individual user may be used for internal operational purposes.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">4. SMS messaging program</h2>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <span className="font-medium">Program name:</span> {BUSINESS_NAME}{" "}
                  Pickup Notifications
                </li>
                <li>
                  <span className="font-medium">Message frequency:</span> Message
                  frequency varies based on your order activity. You will typically
                  receive 2–6 messages per pickup (confirmation, pickup
                  notification, delivery notification, and any necessary follow-up).
                  You will not receive marketing or promotional messages.
                </li>
                <li>
                  <span className="font-medium">Message and data rates may apply.</span>{" "}
                  Standard messaging and data rates from your wireless carrier may
                  apply to each message sent or received. Contact your carrier for
                  details about your plan.
                </li>
                <li>
                  <span className="font-medium">Opt-in:</span> By texting "clean" or
                  any pickup request to our number, you consent to receive SMS
                  messages from {BUSINESS_NAME} related to your dry cleaning orders.
                </li>
                <li>
                  <span className="font-medium">Opt-out:</span> You can opt out at
                  any time by replying <span className="font-mono">STOP</span> to
                  any of our messages. You will receive a confirmation message and
                  no further messages will be sent.
                </li>
                <li>
                  <span className="font-medium">Help:</span> Reply{" "}
                  <span className="font-mono">HELP</span> for assistance, or contact
                  us at {CONTACT_EMAIL}.
                </li>
                <li>
                  <span className="font-medium">Supported carriers:</span> Compatible
                  with all major U.S. carriers. Carriers are not liable for delayed
                  or undelivered messages.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">5. Data retention &amp; security</h2>
              <p>
                We retain order information for as long as necessary to fulfill the
                service and to maintain reasonable business records. We take
                reasonable administrative and technical measures to protect your
                information from unauthorized access.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">6. Your rights</h2>
              <p>
                You may request that we delete your personal information from our
                records by emailing {CONTACT_EMAIL}. Note that opting out of SMS
                does not automatically delete prior order records.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">7. Changes to this policy</h2>
              <p>
                We may update this policy from time to time. Material changes will be
                reflected by updating the "Last updated" date at the top of this
                page.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">8. Contact</h2>
              <p>
                Questions about this policy? Email {CONTACT_EMAIL} or text/call {CONTACT_PHONE}.
              </p>
            </section>
          </CardContent>
        </Card>

        {/* ─────────────── TERMS OF SERVICE ─────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Terms of Service</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 text-sm leading-relaxed">
            <section>
              <h2 className="font-semibold text-base mb-2">1. The service</h2>
              <p>
                {BUSINESS_NAME} provides SMS-based dry cleaning pickup and delivery
                in {SERVICE_AREA}. By using the service, you agree to these terms.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">2. Scheduling and pickup</h2>
              <p>
                Pickup requests are scheduled via SMS.{" "}
                <span className="font-medium">
                  Orders must be placed by 12:00 AM (midnight) the night before
                  your pickup day.
                </span>{" "}
                Requests received after the cutoff will be scheduled for a later
                pickup date or not processed at all. We will make reasonable efforts to pick up your
                order on the requested date, but pickup and delivery times are
                estimates and are not guaranteed. Please leave your bag at the
                agreed-upon location and provide accurate gate codes when
                applicable.
              </p>
              <p className="mt-2 font-medium">
                Return schedule: our service currently returns clean clothing no
                later than Thursday. If a Friday return is ever necessary, we
                will be in touch with you directly to make arrangements.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">3. Pricing and payment</h2>
              <p>
                Pricing is communicated at or before pickup. Payment is due upon
                delivery unless otherwise agreed. You are responsible for the full
                amount owed for any order we have picked up and processed.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">4. Garment care &amp; liability</h2>
              <p>
                We handle your garments with reasonable care and follow generally
                accepted industry practice (consistent with the Drycleaning &amp;
                Laundry Institute's Fair Claims Guide). By using the service, you
                acknowledge and agree to the following:
              </p>
              <ul className="list-disc pl-5 space-y-1 mt-2">
                <li>
                  <span className="font-medium">Items not accepted at our risk.</span>{" "}
                  We are not responsible for loss or damage to leather, suede, fur,
                  wedding gowns, heirloom or antique garments, or any item lacking a
                  care label, unless we expressly accept it in writing.
                </li>
                <li>
                  <span className="font-medium">Trim, buttons, and embellishments.</span>{" "}
                  We are not responsible for damage to buttons, zippers, belts,
                  buckles, sequins, beads, appliques, or other trim that may not
                  withstand normal cleaning.
                </li>
                <li>
                  <span className="font-medium">Pre-existing conditions.</span>{" "}
                  We are not responsible for pre-existing damage; weakened, worn,
                  faded, or sun-damaged fabric; shrinkage, stretching, color loss,
                  or bleeding inherent to the fabric or dye; or for results caused
                  by inaccurate or missing care labels or manufacturer defects.
                </li>
                <li>
                  <span className="font-medium">Items left in pockets.</span> Please
                  check all pockets before drop-off. We are not responsible for
                  cash, jewelry, electronics, keys, or any other item left in
                  garments.
                </li>
                <li>
                  <span className="font-medium">Stain &amp; odor removal.</span> We
                  will make reasonable efforts to remove stains and odors, but
                  complete removal cannot be guaranteed.
                </li>
                <li>
                  <span className="font-medium">Claim window.</span> All claims for
                  loss or damage must be reported to us in writing within seven (7)
                  days of delivery. Claims made after this window may not be
                  honored.
                </li>
                <li>
                  <span className="font-medium">Maximum liability.</span> Our
                  maximum liability for any lost or damaged item is limited to the
                  lesser of (a) ten (10) times the cleaning charge for that item or
                  (b) the depreciated fair market value of the item at the time of
                  loss, calculated using the Fair Claims Guide depreciation
                  schedule. We are not liable for incidental, consequential, or
                  sentimental damages.
                </li>
                <li>
                  <span className="font-medium">Unclaimed garments.</span> Garments
                  not retrieved or accepted at delivery within sixty (60) days may
                  be donated or otherwise disposed of without further notice or
                  liability.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">5. Referral program</h2>
              <p>
                Refer your neighbors and earn free pickups. The program works as
                follows:
              </p>
              <ul className="list-disc pl-5 space-y-1 mt-2">
                <li>
                  For every {REFERRAL_THRESHOLD} neighbors you refer who complete
                  their first paid pickup with {BUSINESS_NAME}, you earn one
                  free pickup credit worth up to{" "}
                  <span className="font-medium">${REFERRAL_CREDIT_USD}</span>.
                </li>
                <li>
                  If your next order is more than ${REFERRAL_CREDIT_USD}, the
                  credit applies as a ${REFERRAL_CREDIT_USD} discount and you
                  pay the remainder.
                </li>
                <li>
                  A referral only qualifies when the referred customer is brand
                  new to {BUSINESS_NAME} and pays for their first pickup. Repeat
                  customers, duplicates, or self-referrals do not count.
                </li>
                <li>
                  Each phone number can be referred only once, by one referrer.
                </li>
                <li>
                  Lifetime cap of {REFERRAL_MAX_REDEMPTIONS} free pickup credits
                  per household ({REFERRAL_THRESHOLD * REFERRAL_MAX_REDEMPTIONS}{" "}
                  qualified referrals total).
                </li>
                <li>
                  Credits are non-transferable, have no cash value, and cannot
                  be combined with other discounts.
                </li>
                <li>
                  {BUSINESS_NAME} may modify, suspend, or end the referral
                  program at any time. Credits already earned will still be
                  honored.
                </li>
              </ul>
              <p className="mt-2">
                To add a referral, text "refer" to {CONTACT_PHONE} or ask us on
                your next pickup.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">6. Cancellation &amp; missed pickups</h2>
              <p>
                You may cancel a scheduled pickup by replying to our confirmation
                message before the pickup window. If we attempt a pickup and the bag
                is not available, we may mark the order as missed; a re-pickup fee
                may apply.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">7. Acceptable use</h2>
              <p>
                You agree not to use the service to submit fraudulent orders, harass
                staff, or send abusive messages. We reserve the right to refuse
                service.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">8. Changes to these terms</h2>
              <p>
                {BUSINESS_NAME} may change, update, or replace these terms — and the
                Privacy Policy above — at any time, at our sole discretion, with or
                without prior notice. The current version is always posted on this
                page, and the "Last updated" date at the top reflects the most
                recent revision. Your continued use of the service after any change
                constitutes your acceptance of the updated terms. If you do not
                agree to a change, your sole remedy is to stop using the service.
              </p>
            </section>

            <section>
              <h2 className="font-semibold text-base mb-2">9. Contact</h2>
              <p>
                Questions about these terms? Email {CONTACT_EMAIL} or text/call {CONTACT_PHONE}.
              </p>
            </section>
          </CardContent>
        </Card>

        <footer className="mt-8 text-center text-xs text-muted-foreground">
          &copy; {new Date().getFullYear()} {BUSINESS_NAME}. All rights reserved.
        </footer>
      </div>
    </div>
  );
}
