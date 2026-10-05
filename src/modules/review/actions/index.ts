"use server";

import prisma from "@/lib/db";
import { auth } from "@/lib/auth";
import {headers} from "next/headers";


export async function getReview(){

    const session =await auth.api.getSession({
        headers:await headers()
    });

    if(!session?.user?.id){
        throw new Error("User not authenticated");
    }

    const reviews =await prisma.reviewRun.findMany({
        where:{
            repository:{
                userId:session.user.id
            }
        },
        include:{
            repository:true,
            pullRequest:true
        },
        orderBy:{
            updatedAt:"desc"
        },
        take:50
    })

    return reviews;
}
