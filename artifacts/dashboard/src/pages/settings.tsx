import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
} from "@workspace/api-client-react";
import { SiteNav } from "@/components/site-nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { parseDollarsToCents } from "@/lib/money";

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() },
  });
  const [fee, setFee] = useState("");
  const [minimum, setMinimum] = useState("");
  const [wholesale, setWholesale] = useState("");

  useEffect(() => {
    if (data) {
      setFee((data.feeCents / 100).toFixed(2));
      setMinimum((data.orderMinimumCents / 100).toFixed(2));
      setWholesale(String(data.wholesalePercent));
    }
  }, [data]);

  const update = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        toast.success("Settings saved");
      },
      onError: () => toast.error("Could not save settings"),
    },
  });

  return (
    <div className="max-w-2xl mx-auto p-6">
      <SiteNav />
      <Card>
        <CardHeader>
          <CardTitle>Pricing Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Pickup &amp; delivery fee</Label>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">$</span>
                  <Input
                    value={fee}
                    onChange={(e) => setFee(e.target.value)}
                    inputMode="decimal"
                    className="max-w-[120px]"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Added to every order's total as the "Pickup &amp; delivery" line.
                  Changes here only apply to <em>future</em> pricing — past orders
                  keep their snapshotted fee.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Order minimum (warning threshold)</Label>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">$</span>
                  <Input
                    value={minimum}
                    onChange={(e) => setMinimum(e.target.value)}
                    inputMode="decimal"
                    className="max-w-[120px]"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Orders priced below this show a "below minimum" warning, but are
                  never blocked.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Wholesale percentage (for profit estimate only)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={wholesale}
                    onChange={(e) => setWholesale(e.target.value)}
                    inputMode="numeric"
                    className="max-w-[100px]"
                  />
                  <span className="text-muted-foreground">%</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  What share of items revenue goes to the wholesale cleaner.
                  Used only by the earnings report's profit estimate.
                </p>
              </div>
              <Button
                disabled={update.isPending}
                onClick={() => {
                  const feeCents = parseDollarsToCents(fee);
                  const orderMinimumCents = parseDollarsToCents(minimum);
                  const wholesalePercent = Number(wholesale);
                  if (
                    feeCents == null ||
                    orderMinimumCents == null ||
                    !Number.isInteger(wholesalePercent) ||
                    wholesalePercent < 0 ||
                    wholesalePercent > 100
                  ) {
                    toast.error("Check your values — fees in dollars, % as 0–100");
                    return;
                  }
                  update.mutate({
                    data: { feeCents, orderMinimumCents, wholesalePercent },
                  });
                }}
              >
                Save Settings
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
