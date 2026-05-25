import { Router } from "express";
import twilio from "twilio";
import { db } from "@workspace/db";
import { conversationsTable, ordersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router = Router();

function twimlResponse(message: string): string {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  return twiml.toString();
}

function generateOrderNumber(): string {
  const num = Math.floor(10000 + Math.random() * 90000);
  return `DRY-${num}`;
}

router.post("/webhook/twilio", async (req, res) => {
  const body = req.body as { Body?: string; From?: string };
  const from = (body.From ?? "").trim();
  const text = (body.Body ?? "").trim().toLowerCase();

  res.setHeader("Content-Type", "text/xml");

  if (!from) {
    res.send(twimlResponse("Unable to process your request."));
    return;
  }

  // Start conversation
  if (text === "clean") {
    await db
      .insert(conversationsTable)
      .values({ phoneNumber: from, step: "name" })
      .onConflictDoUpdate({
        target: conversationsTable.phoneNumber,
        set: { step: "name", name: null, town: null, colony: null, unitNumber: null, updatedAt: new Date() },
      });
    res.send(twimlResponse("Welcome to Fresh Pick Dry Cleaning! 👕\n\nWhat is your full name?"));
    return;
  }

  // Look up active conversation
  const [convo] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, from))
    .limit(1);

  if (!convo) {
    res.send(twimlResponse('Text "clean" to start a dry cleaning pickup request.'));
    return;
  }

  const step = convo.step;

  if (step === "name") {
    await db
      .update(conversationsTable)
      .set({ name: body.Body?.trim(), step: "town", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(`Thanks, ${body.Body?.trim()}! What town are you in?`));
    return;
  }

  if (step === "town") {
    await db
      .update(conversationsTable)
      .set({ town: body.Body?.trim(), step: "colony", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse("Got it! What is your colony or neighborhood name?"));
    return;
  }

  if (step === "colony") {
    await db
      .update(conversationsTable)
      .set({ colony: body.Body?.trim(), step: "unit", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse("Great! What is your unit number or house number?"));
    return;
  }

  if (step === "unit") {
    await db
      .update(conversationsTable)
      .set({ unitNumber: body.Body?.trim(), step: "gate", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(
      twimlResponse(
        "Almost done! Do you have a front gate that requires access?\nIf yes, reply with the gate code or instructions.\nIf no, just reply \"no\"."
      )
    );
    return;
  }

  if (step === "gate") {
    const gateAccess = text === "no" ? null : body.Body?.trim() ?? null;
    const orderNumber = generateOrderNumber();

    await db.insert(ordersTable).values({
      orderNumber,
      phoneNumber: from,
      name: convo.name!,
      town: convo.town!,
      colony: convo.colony!,
      unitNumber: convo.unitNumber!,
      gateAccess,
      status: "pending",
    });

    await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));

    const gateMsg = gateAccess ? `Gate access: ${gateAccess}` : "No gate access needed.";
    res.send(
      twimlResponse(
        `Your pickup is confirmed! 🎉\n\nOrder #${orderNumber}\nName: ${convo.name}\nTown: ${convo.town}\nColony: ${convo.colony}\nUnit: ${convo.unitNumber}\n${gateMsg}\n\nWe'll be in touch soon!`
      )
    );
    return;
  }

  res.send(twimlResponse('Text "clean" to start a new pickup request.'));
});

export default router;
