import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ordersRouter from "./orders";
import twilioRouter from "./twilio";
import adminRouter from "./admin";
import routeRouter from "./route";
import { requireAdmin } from "../middlewares/admin-auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(adminRouter);
router.use(twilioRouter);
router.use(requireAdmin, ordersRouter);
router.use(requireAdmin, routeRouter);

export default router;
