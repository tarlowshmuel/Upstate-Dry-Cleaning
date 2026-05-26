import { useState } from "react";
import {
  useGetEarnings,
  getGetEarningsQueryKey,
} from "@workspace/api-client-react";
import { SiteNav } from "@/components/site-nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCents } from "@/lib/money";

type Period = "today" | "week" | "month" | "all";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold mt-1">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground mt-1">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

export default function EarningsPage() {
  const [period, setPeriod] = useState<Period>("week");
  const { data, isLoading } = useGetEarnings(
    { period },
    { query: { queryKey: getGetEarningsQueryKey({ period }) } },
  );

  return (
    <div className="max-w-6xl mx-auto p-6">
      <SiteNav />
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Earnings</h1>
          <p className="text-sm text-muted-foreground">
            Only priced orders count. Unpriced orders are excluded from these totals.
          </p>
        </div>
        <Tabs value={period} onValueChange={(v) => setPeriod(v as Period)}>
          <TabsList>
            <TabsTrigger value="today">Today</TabsTrigger>
            <TabsTrigger value="week">This Week</TabsTrigger>
            <TabsTrigger value="month">This Month</TabsTrigger>
            <TabsTrigger value="all">All Time</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <Stat label="Orders" value={String(data.orderCount)} />
            <Stat label="Gross revenue" value={formatCents(data.grossRevenueCents)} />
            <Stat
              label="Paid"
              value={formatCents(data.paidCents)}
              hint={`Outstanding ${formatCents(data.outstandingCents)}`}
            />
            <Stat
              label="Profit estimate"
              value={formatCents(data.profitEstimateCents)}
              hint={`Revenue − ${data.wholesalePercent}% of items revenue`}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <Stat label="Items revenue" value={formatCents(data.itemsRevenueCents)} />
            <Stat label="Fees collected" value={formatCents(data.feesCollectedCents)} />
            <Stat
              label="Wholesale est."
              value={formatCents(
                Math.round((data.wholesalePercent * data.itemsRevenueCents) / 100),
              )}
              hint={`${data.wholesalePercent}% of items revenue`}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">By payment method</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Method</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell>Zelle</TableCell>
                      <TableCell className="text-right">{formatCents(data.byMethod.zelle)}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Cash</TableCell>
                      <TableCell className="text-right">{formatCents(data.byMethod.cash)}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-muted-foreground">Unspecified</TableCell>
                      <TableCell className="text-right">{formatCents(data.byMethod.unknown)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">By pickup day</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.byRouteDay.length === 0 ? (
                  <p className="p-6 text-sm text-muted-foreground">No data for this period.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Orders</TableHead>
                        <TableHead className="text-right">Revenue</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.byRouteDay.map((d) => (
                        <TableRow key={d.date}>
                          <TableCell>{d.date === "no-date" ? "(no pickup date)" : d.date}</TableCell>
                          <TableCell>{d.count}</TableCell>
                          <TableCell className="text-right">{formatCents(d.revenueCents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
