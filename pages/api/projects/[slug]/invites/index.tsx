import { createHash, randomBytes } from 'crypto';
import sendMail from 'emails';
import TeamInvite from 'emails/TeamInvite';
import { NextApiRequest, NextApiResponse } from 'next';

import { withProjectAuth } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { ProjectProps } from '@/lib/types';

const hashToken = (token: string) => {
  return createHash('sha256').update(`${token}${process.env.NEXTAUTH_SECRET}`).digest('hex');
};

export default withProjectAuth(async (req: NextApiRequest, res: NextApiResponse, project: ProjectProps) => {
  const { slug } = req.query;
  if (!slug || typeof slug !== 'string') {
    return res.status(400).json({ error: 'Missing or misconfigured project slug' });
  }

  // GET /api/projects/[slug]/invite - Get all pending invites for a project
  if (req.method === 'GET') {
    const invites = await prisma.projectInvite.findMany({
      where: {
        projectId: project.id
      },
      select: {
        email: true,
        createdAt: true
      }
    });
    return res.status(200).json(
      invites.map((invite) => ({
        email: invite.email,
        joinedAt: invite.createdAt
      }))
    );

    // POST /api/projects/[slug]/invite – invite a teammate
  } else if (req.method === 'POST') {
    const { email } = req.body;

    const alreadyInTeam = await prisma.projectUsers.findFirst({
      where: {
        projectId: project.id,
        user: {
          email
        }
      }
    });
    if (alreadyInTeam) {
      return res.status(400).json({ error: 'User already exists in this project' });
    }

    // same method of generating a token as next-auth
    const token = randomBytes(32).toString('hex');
    const ONE_WEEK_IN_SECONDS = 604800;
    const expires = new Date(Date.now() + ONE_WEEK_IN_SECONDS * 1000);

    // create a project invite record and a verification request token that lasts for a week
    try {
      await prisma.projectInvite.create({
        data: {
          email,
          expires,
          projectId: project.id
        }
      });

      await prisma.verificationToken.create({
        data: {
          identifier: email,
          token: hashToken(token),
          expires
        }
      });

      const params = new URLSearchParams({
        callbackUrl: `${process.env.NEXTAUTH_URL}/p/${slug}`,
        email,
        token
      });

      const url = `${process.env.NEXTAUTH_URL}/control/api/auth/callback/email?${params}`;

      sendMail({
        subject: "You've been invited to join a project on Stub",
        to: email,
        component: <TeamInvite url={url} />
      });

      return res.status(200).json({ message: 'Invite sent' });
    } catch (error) {
      return res.status(400).json({ error: 'User already invited' });
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
});
