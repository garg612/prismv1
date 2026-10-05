"use server";

import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import prisma from "@/lib/db";
import { revalidatePath } from "next/cache";
import { deleteWebhook } from "@/modules/github/lib/github";
import { deleteRepositoryNamespace, deleteLegacyRepositoryVectors } from "@/lib/pinecone";

export async function getUserProfile(){
    try{
        const session = await auth.api.getSession({
            headers:await headers(),
        })
        if(!session?.user){
            throw new Error("Unauthorized")
        }
        const user = await prisma.user.findUnique({
            where:{
                id:session.user.id,
            },
            select:{
                id:true,
                name:true,
                image:true,
                email:true,
                createdAt:true,
                
            }
        })
        return user
    }catch(err){
        console.log(err)
        throw new Error("Failed to fetch user profile")
    }
}

export async function updateUserProfile(
    data:{
        name?:string;
        email?:string;
        image?:string;
    }
){
    try{
        const session = await auth.api.getSession({
            headers:await headers(),
        })
        if(!session?.user){
            throw new Error("Unauthorized")
        }
        const updatedUser = await prisma.user.update({
            where:{
                id:session.user.id,
            },
            data:{
                name:data.name,
                email:data.email
            },
            select:{
                id:true,
                name:true,
                email:true,
            }
        })
        revalidatePath("dashboard/settings","layout")
        return{
            success:true,
            message:"User profile updated successfully",
            user:updatedUser
        }
    }catch(err){
        console.log(err)
        throw new Error("Failed to update user profile")
    }
}

export async function getConnectedRepositories(){
    try{
        const session=await auth.api.getSession({
            headers:await headers()
        })
        if(!session?.user){
            throw new Error("Unauthorized");
        }
        const repositories = await prisma.repository.findMany({
            where:{
                userId:session.user.id,
            },
            select:{
                id:true,
                name:true,
                owner:true,
                url:true,
                fixDeliveryMode:true,
                executionValidation:true,
                holisticReview:true,
                createdAt:true,
                updatedAt:true
            },
            orderBy:{
                createdAt:"desc"
            }
        })
        return repositories
    }catch(err){
        console.log(err)
        return []
    }
}

const FIX_DELIVERY_MODES = ["FIX_BRANCH_PR", "DIRECT_COMMIT", "SUGGESTION_COMMENT"];

/** Turn "run the repository's tests on each fix" on or off for one repository the caller owns. */
export async function updateExecutionValidation(repositoryId: string, enabled: boolean) {
    try {
        const session = await auth.api.getSession({ headers: await headers() });
        if (!session?.user) throw new Error("Unauthorized");
        if (typeof repositoryId !== "string" || !repositoryId) throw new Error("Repository not found");
        if (typeof enabled !== "boolean") throw new Error("Invalid value");

        // Ownership is part of the write itself, so there is no gap between the check and the update.
        const updated = await prisma.repository.updateMany({
            where: { id: repositoryId, userId: session.user.id },
            data: { executionValidation: enabled }
        });
        if (updated.count === 0) throw new Error("Repository not found");

        revalidatePath("dashboard/settings", "page");
        return { success: true, executionValidation: enabled };
    } catch (err: any) {
        throw new Error(err.message || "Failed to update repository settings");
    }
}

/** Turn the AI logic review of each pull request on or off for one repository the caller owns. */
export async function updateLogicReview(repositoryId: string, enabled: boolean) {
    try {
        const session = await auth.api.getSession({ headers: await headers() });
        if (!session?.user) throw new Error("Unauthorized");
        if (typeof repositoryId !== "string" || !repositoryId) throw new Error("Repository not found");
        if (typeof enabled !== "boolean") throw new Error("Invalid value");

        const updated = await prisma.repository.updateMany({
            where: { id: repositoryId, userId: session.user.id },
            data: { holisticReview: enabled }
        });
        if (updated.count === 0) throw new Error("Repository not found");

        revalidatePath("dashboard/settings", "page");
        return { success: true, logicReview: enabled };
    } catch (err: any) {
        throw new Error(err.message || "Failed to update repository settings");
    }
}

export async function updateRepositorySettings(repositoryId: string, fixDeliveryMode: string) {
    try {
        const session = await auth.api.getSession({ headers: await headers() });
        if (!session?.user) throw new Error("Unauthorized");
        if (!FIX_DELIVERY_MODES.includes(fixDeliveryMode)) throw new Error("Invalid fix mode");
        
        const repository = await prisma.repository.findUnique({
            where: { id: repositoryId, userId: session.user.id }
        });
        
        if (!repository) throw new Error("Repository not found");
        
        await prisma.repository.update({
            where: { id: repositoryId },
            data: { fixDeliveryMode }
        });
        
        revalidatePath("dashboard/settings", "page");
        return { success: true };
    } catch (err: any) {
        throw new Error(err.message || "Failed to update repository settings");
    }
}

export async function disconnectRepository(repositoryId:string){
    try{
        const session=await auth.api.getSession({
            headers:await headers()
        })
        if(!session?.user){
            throw new Error("Unauthorized");
        }
        const repository = await prisma.repository.findUnique({
            where:{
                id:repositoryId,
                userId:session.user.id,
            }
        })
        if(!repository){
            throw new Error("Repository not found")
        }
        await deleteWebhook(repository.owner,repository.name);

        // Stage 5: delete repository vectors from Pinecone namespace and legacy
        try {
            await deleteRepositoryNamespace(repositoryId);
            await deleteLegacyRepositoryVectors(repository.fullName);
        } catch(err) {
            console.error(`Failed to delete Pinecone vectors for ${repositoryId}:`, err);
            // Non-fatal: continue with DB deletion
        }

        await prisma.repository.delete({
            where:{
                id:repositoryId,
                userId:session.user.id
            }
        })
        revalidatePath("dashboard/settings","page")
        revalidatePath("dashboard/repository","page")
        return {
            success:true,
            message:"Repository disconnected successfully",
        }
    }catch(err){
        console.log(err)
        throw new Error("Failed to disconnect repository")
    }
}


export async function disconnectAllRepositories(){
    try{
        const session=await auth.api.getSession({
            headers:await headers()
        })
        if(!session?.user){
            throw new Error("Unauthorized");
        }
        const repositories = await prisma.repository.findMany({
            where:{
                userId:session.user.id,
            }
        })
        await Promise.all(repositories.map(async(repo)=>{
            try{
                await deleteWebhook(repo.owner,repo.name);
            }catch(err){
                console.log(`Failed to delete webhook for ${repo.name}`,err);
            }
            // Stage 5: delete Pinecone namespace and legacy vectors per repository
            try {
                await deleteRepositoryNamespace(repo.id);
                await deleteLegacyRepositoryVectors(repo.fullName);
            } catch(err) {
                console.error(`Failed to delete Pinecone vectors for ${repo.id}:`, err);
            }
        }))
        await prisma.repository.deleteMany({
            where:{
                userId:session.user.id
            }
        })
        revalidatePath("dashboard/settings","page")
        revalidatePath("dashboard/repository","page")
        return {
            success:true,
            message:"All repositories disconnected successfully",
        }
    }catch(err){
        console.log(err)
        throw new Error("Failed to disconnect all repositories")
    }
}
