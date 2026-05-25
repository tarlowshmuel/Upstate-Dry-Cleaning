import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ordersRouter from "./orders";
import twilioRouter from "./twilio";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ordersRouter);
router.use(twilioRouter);

export default router;
