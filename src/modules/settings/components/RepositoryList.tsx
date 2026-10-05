import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import {
    useQuery,
    useMutation,
    useQueryClient,
} from "@tanstack/react-query";

import {
    getConnectedRepositories,
    disconnectRepository,
    disconnectAllRepositories,
} from "@/modules/settings/actions/index";

import { toast } from "sonner";

import {
    ExternalLink,
    Trash2,
    AlertTriangle,
} from "lucide-react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { ErrorState } from "@/components/ErrorState";

import { useState } from "react";

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { updateRepositorySettings, updateExecutionValidation, updateLogicReview } from "@/modules/settings/actions/index";
import { Switch } from "@/components/ui/switch";

export function RepositoryList() {

    const queryClient = useQueryClient();

    const [disconnectAllOpen, setDisconnectAllOpen] = useState<boolean>(false);

    const { data: repositories, isLoading, error } = useQuery({
        queryKey: ["connected-repositories"],
        queryFn: async () => await getConnectedRepositories(),
        staleTime: 1000 * 60 * 2,
        refetchOnWindowFocus: false
    });

    const updateModeMutation = useMutation({
        mutationFn: async ({ id, mode }: { id: string, mode: string }) => {
            return await updateRepositorySettings(id, mode);
        },
        onSuccess: (result) => {
            if (result?.success) {
                queryClient.invalidateQueries({ queryKey: ["connected-repositories"] });
                toast.success("Settings updated");
            }
        },
        onError: (error) => {
            toast.error(error.message);
        },
    });

    const executionMutation = useMutation({
        mutationFn: async ({ id, enabled }: { id: string, enabled: boolean }) => {
            return await updateExecutionValidation(id, enabled);
        },
        onSuccess: (result) => {
            if (result?.success) {
                queryClient.invalidateQueries({ queryKey: ["connected-repositories"] });
                toast.success(result.executionValidation ? "Fixes will be tested before they are offered" : "Fixes will be checked by static analysis only");
            }
        },
        onError: (error) => {
            toast.error(error.message);
        },
    });

    const logicReviewMutation = useMutation({
        mutationFn: async ({ id, enabled }: { id: string, enabled: boolean }) => {
            return await updateLogicReview(id, enabled);
        },
        onSuccess: (result) => {
            if (result?.success) {
                queryClient.invalidateQueries({ queryKey: ["connected-repositories"] });
                toast.success(result.logicReview ? "Pull requests will get an AI logic review" : "AI logic review turned off");
            }
        },
        onError: (error) => {
            toast.error(error.message);
        },
    });

    const disconnectMutation = useMutation({
        mutationFn: async (repositoryId: string) => {
            return await disconnectRepository(repositoryId);
        },
        onSuccess: (result) => {
            if (result?.success) {
                queryClient.invalidateQueries({ queryKey: ["connected-repositories"] });
                queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
                toast.success("Repository disconnected successfully");
            }
        },
        onError: (error) => {
            toast.error(error.message);
        },
    });

    const disconnectAllMutation = useMutation({
        mutationFn: async () => {
            return await disconnectAllRepositories();
        },
        onSuccess: (result) => {
            if (result?.success) {
                queryClient.invalidateQueries({ queryKey: ["connected-repositories"] });
                queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
                toast.success(result.message);
                setDisconnectAllOpen(false);
            }
        },
        onError: (error) => {
            toast.error(error.message);
        },
    });

    if (isLoading) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Connected Repositories</CardTitle>
                    <CardDescription>
                        Manage your connected GitHub repositories
                    </CardDescription>
                </CardHeader>

                <CardContent>
                    <div className="space-y-4">
                        <Skeleton className="h-20" />
                        <Skeleton className="h-20" />
                    </div>
                </CardContent>
            </Card>
        )
    }
    if (error) {
        return <ErrorState title="Error Loading Repositories" message={error.message} />
    }

    if (repositories?.length === 0) {
        return (
            <Empty className="my-8">
                <EmptyTitle>No repositories connected</EmptyTitle>
                <EmptyDescription>
                    You haven&apos;t connected any GitHub repositories yet. Go to the Repositories page to connect one.
                </EmptyDescription>
            </Empty>
        )
    }

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between">
                <div className="space-y-1.5">
                    <CardTitle>Connected Repositories</CardTitle>
                    <CardDescription>
                        Manage your connected GitHub repositories
                    </CardDescription>
                </div>
                {repositories && repositories.length > 0 && (
                    <AlertDialog open={disconnectAllOpen} onOpenChange={setDisconnectAllOpen}>
                        <AlertDialogTrigger asChild>
                            <Button
                                variant="destructive"
                                size="sm"
                                disabled={disconnectAllMutation.isPending}
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Disconnect All
                            </Button>
                        </AlertDialogTrigger>

                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>Disconnect All Repositories?</AlertDialogTitle>
                                <AlertDialogDescription>
                                    This will disconnect all your connected GitHub repositories and delete the associated webhooks. This action cannot be undone.
                                </AlertDialogDescription>
                            </AlertDialogHeader>

                            <AlertDialogFooter>
                                <AlertDialogCancel disabled={disconnectAllMutation.isPending}>
                                    Cancel
                                </AlertDialogCancel>
                                <AlertDialogAction
                                    onClick={() => disconnectAllMutation.mutate()}
                                    disabled={disconnectAllMutation.isPending}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                    {disconnectAllMutation.isPending ? "Disconnecting..." : "Disconnect All"}
                                </AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                )}
            </CardHeader>
            <CardContent>
                <div className="space-y-4">
                    {repositories?.map((repo) => (
                        <div key={repo.id} className="flex flex-col md:flex-row items-start md:items-center justify-between p-4 border rounded-lg bg-card/50 hover:bg-muted/50 transition-colors gap-4">
                            <div className="flex flex-col gap-1.5 min-w-0">
                                <div className="font-medium leading-none flex items-center gap-2">
                                    <span className="truncate">{repo.name}</span>
                                    <Badge variant="outline" className="text-[10px] uppercase h-5 px-1.5 bg-success/10 text-success border-success/20 shrink-0">
                                        Connected
                                    </Badge>
                                </div>
                                <p className="text-sm text-muted-foreground truncate">
                                    {repo.owner} • Added {new Date(repo.createdAt).toLocaleDateString()}
                                </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-4 shrink-0">
                                <label
                                    className="flex items-center gap-2"
                                    title="Runs this repository's own lint, build and test scripts in an isolated sandbox, before and after each fix. A fix that breaks them is not offered. Needs a package.json with a package-lock.json; otherwise fixes are checked by static analysis only."
                                >
                                    <span className="text-xs text-muted-foreground">Test fixes:</span>
                                    <Switch
                                        size="sm"
                                        checked={!!repo.executionValidation}
                                        disabled={executionMutation.isPending}
                                        onCheckedChange={(checked) => executionMutation.mutate({ id: repo.id, enabled: checked })}
                                        aria-label={`Run ${repo.name}'s tests on each fix`}
                                    />
                                </label>
                                <label
                                    className="flex items-center gap-2"
                                    title="An AI model reads each pull request's changes and points out possible logic bugs that scanners cannot find. Its suggestions are shown separately, are not verified, and are never fixed automatically."
                                >
                                    <span className="text-xs text-muted-foreground">Logic review:</span>
                                    <Switch
                                        size="sm"
                                        checked={!!repo.holisticReview}
                                        disabled={logicReviewMutation.isPending}
                                        onCheckedChange={(checked) => logicReviewMutation.mutate({ id: repo.id, enabled: checked })}
                                        aria-label={`AI logic review for ${repo.name}`}
                                    />
                                </label>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-muted-foreground">Fix Mode:</span>
                                    <Select 
                                        value={repo.fixDeliveryMode || "FIX_BRANCH_PR"} 
                                        onValueChange={(v) => updateModeMutation.mutate({ id: repo.id, mode: v })}
                                    >
                                        <SelectTrigger className="w-[140px] h-8 text-xs">
                                            <SelectValue placeholder="Delivery Mode" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="FIX_BRANCH_PR" className="text-xs">Stacked PR</SelectItem>
                                            <SelectItem value="DIRECT_COMMIT" className="text-xs">Direct Commit</SelectItem>
                                            <SelectItem value="SUGGESTION_COMMENT" className="text-xs">Suggestion</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Button variant="outline" size="icon" asChild className="h-8 w-8">
                                        <a href={repo.url} target="_blank" rel="noopener noreferrer" aria-label={`View ${repo.name} on GitHub`}>
                                            <ExternalLink className="h-4 w-4 text-muted-foreground" />
                                        </a>
                                    </Button>
                                    <AlertDialog>
                                        <AlertDialogTrigger asChild>
                                            <Button 
                                                variant="destructive" 
                                                size="icon" 
                                                className="h-8 w-8"
                                                disabled={disconnectMutation.isPending}
                                                title="Disconnect Repository"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </AlertDialogTrigger>
                                        <AlertDialogContent>
                                            <AlertDialogHeader>
                                                <AlertDialogTitle>Disconnect {repo.name}?</AlertDialogTitle>
                                                <AlertDialogDescription>
                                                    This will disconnect the repository and remove its associated webhook. This action cannot be undone.
                                                </AlertDialogDescription>
                                            </AlertDialogHeader>
                                            <AlertDialogFooter>
                                                <AlertDialogCancel disabled={disconnectMutation.isPending}>Cancel</AlertDialogCancel>
                                                <AlertDialogAction
                                                    onClick={() => disconnectMutation.mutate(repo.id)}
                                                    disabled={disconnectMutation.isPending}
                                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                                >
                                                    {disconnectMutation.isPending ? "Disconnecting..." : "Disconnect"}
                                                </AlertDialogAction>
                                            </AlertDialogFooter>
                                        </AlertDialogContent>
                                    </AlertDialog>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    )
}