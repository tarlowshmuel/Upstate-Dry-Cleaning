import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ordersRouter from "./orders";
import twilioRouter from "./twilio";
import routeRouter from "./route";
import priceListRouter from "./price-list";
import settingsRouter from "./settings";
import earningsRouter from "./earnings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(twilioRouter);
router.use(ordersRouter);
router.use(routeRouter);
router.use(priceListRouter);
router.use(settingsRouter);
router.use(earningsRouter);

export default router;
