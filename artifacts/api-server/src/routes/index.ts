import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ordersRouter from "./orders";
import twilioRouter from "./twilio";
import routeRouter from "./route";

const router: IRouter = Router();

router.use(healthRouter);
router.use(twilioRouter);
router.use(ordersRouter);
router.use(routeRouter);

export default router;
