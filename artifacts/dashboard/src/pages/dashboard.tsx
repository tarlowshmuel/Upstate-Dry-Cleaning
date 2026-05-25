import { useListOrders, getListOrdersQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Shirt, Phone, MapPin, Clock, Key, Inbox } from "lucide-react";

export default function Dashboard() {
  const { data: orders, isLoading, isError } = useListOrders({ 
    query: { queryKey: getListOrdersQueryKey() } 
  });

  const getStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case "pending":
        return <Badge variant="secondary" className="bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors font-medium border-0">Pending</Badge>;
      case "picked_up":
        return <Badge variant="secondary" className="bg-blue-100 text-blue-800 hover:bg-blue-200 transition-colors font-medium border-0">Picked Up</Badge>;
      case "delivered":
        return <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 hover:bg-emerald-200 transition-colors font-medium border-0">Delivered</Badge>;
      default:
        return <Badge variant="outline" className="font-medium">{status}</Badge>;
    }
  };

  return (
    <div className="min-h-screen w-full bg-background p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-700">
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground font-serif">Operations</h1>
            <p className="text-muted-foreground mt-1">Manage dry cleaning pickups and deliveries.</p>
          </div>
          <div className="flex items-center gap-3">
             <div className="bg-primary/10 text-primary px-4 py-2 rounded-md font-medium text-sm flex items-center gap-2 border border-primary/20 shadow-sm">
                <Phone className="w-4 h-4" />
                Text "clean" to your Twilio number to start
             </div>
          </div>
        </header>

        <Card className="border-border/60 shadow-sm overflow-hidden bg-card/50 backdrop-blur-sm">
          <CardHeader className="bg-muted/30 border-b border-border/50 pb-4">
            <CardTitle className="text-lg font-medium flex items-center gap-2 font-serif text-foreground">
              <Shirt className="w-5 h-5 text-primary" />
              Active Orders
            </CardTitle>
            <CardDescription className="text-sm">
              All customer requests requiring attention.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-6 space-y-4">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="flex gap-4 items-center">
                    <Skeleton className="h-14 w-full rounded-md opacity-50" />
                  </div>
                ))}
              </div>
            ) : isError ? (
               <div className="p-12 text-center text-destructive flex flex-col items-center justify-center">
                 <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
                    <span className="text-destructive text-xl font-bold">!</span>
                 </div>
                 <p className="font-medium">Failed to load orders. Please try refreshing.</p>
               </div>
            ) : !orders || orders.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-16 text-center animate-in fade-in zoom-in duration-500">
                <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4 shadow-sm border border-primary/20">
                  <Inbox className="w-8 h-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold text-foreground mb-2 font-serif">No orders yet</h3>
                <p className="text-muted-foreground max-w-sm mb-6 text-sm">
                  Your queue is empty. When customers text "clean" to your Twilio number, their orders will appear here instantly.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent border-b-border/60">
                      <TableHead className="w-[130px] font-medium text-xs uppercase tracking-wider text-muted-foreground">Order</TableHead>
                      <TableHead className="font-medium text-xs uppercase tracking-wider text-muted-foreground">Customer</TableHead>
                      <TableHead className="font-medium text-xs uppercase tracking-wider text-muted-foreground">Location</TableHead>
                      <TableHead className="font-medium text-xs uppercase tracking-wider text-muted-foreground">Access</TableHead>
                      <TableHead className="font-medium text-xs uppercase tracking-wider text-muted-foreground">Status</TableHead>
                      <TableHead className="text-right font-medium text-xs uppercase tracking-wider text-muted-foreground">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((order) => (
                      <TableRow key={order.id} className="hover:bg-muted/50 transition-colors cursor-pointer group border-b-border/40">
                        <TableCell className="font-medium py-4">
                           <span className="text-primary font-mono text-sm tracking-tight group-hover:text-primary/80 transition-colors">
                              {order.orderNumber}
                           </span>
                        </TableCell>
                        <TableCell className="py-4">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium text-foreground text-sm">{order.name}</span>
                            <span className="text-xs text-muted-foreground flex items-center gap-1.5 font-mono">
                              <Phone className="w-3 h-3 text-primary/70" />
                              {order.phoneNumber}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="py-4">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-foreground text-sm">
                              {order.unitNumber ? `Unit ${order.unitNumber}, ` : ''}{order.colony}
                            </span>
                            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                              <MapPin className="w-3 h-3 text-primary/70" />
                              {order.town}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="py-4">
                          {order.gateAccess ? (
                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground bg-secondary/80 px-2 py-1 rounded-md border border-border/50">
                              <Key className="w-3 h-3 text-muted-foreground" />
                              {order.gateAccess}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50 text-sm">-</span>
                          )}
                        </TableCell>
                        <TableCell className="py-4">
                          {getStatusBadge(order.status)}
                        </TableCell>
                        <TableCell className="text-right py-4">
                          <div className="flex flex-col items-end gap-0.5">
                            <span className="text-sm font-medium text-foreground">
                              {format(new Date(order.createdAt), "MMM d, yyyy")}
                            </span>
                            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                              <Clock className="w-3 h-3 text-primary/70" />
                              {format(new Date(order.createdAt), "h:mm a")}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
