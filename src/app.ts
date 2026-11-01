import {
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  OnModuleDestroy,
  BeforeApplicationShutdown,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import { PrismaClient, Prisma } from "@prisma/client";
import twilio from "twilio";
import { AuthGuard, AuthRequest, admin } from "./security";
class NewEmployee {
  @IsUUID() userId!: string;
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() @Matches(/^\+[1-9]\d{7,14}$/) phone?: string;
}
class Rename {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
}
class News {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
}
@Injectable()
export class Database
  extends PrismaClient
  implements OnModuleInit, BeforeApplicationShutdown
{
  async onModuleInit() {
    await this.$connect();
  }
  async beforeApplicationShutdown() {
    await this.$disconnect();
  }
}
@Injectable()
export class Delivery implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(private readonly db: Database) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.run().catch(() =>
        console.error("notification-dispatch-failed"),
      );
    }, 1000);
    this.timer.unref();
  }
  async run() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.db.$transaction(
        async (tx) => {
          const notes = await tx.$queryRaw<
            {
              id: string;
              title: string;
              phone: string | null;
              attempts: number;
            }[]
          >`SELECT * FROM "Notification" WHERE status='pending' AND "nextAt"<=now() ORDER BY "nextAt" LIMIT 5 FOR UPDATE SKIP LOCKED`;
          for (const note of notes) {
            try {
              if (
                note.phone &&
                process.env.TWILIO_ACCOUNT_SID &&
                process.env.TWILIO_AUTH_TOKEN &&
                process.env.TWILIO_FROM
              ) {
                await twilio(
                  process.env.TWILIO_ACCOUNT_SID,
                  process.env.TWILIO_AUTH_TOKEN,
                  { timeout: 5000, autoRetry: false },
                ).messages.create({
                  from: process.env.TWILIO_FROM,
                  to: note.phone,
                  body: note.title,
                });
              }
              await tx.notification.update({
                where: { id: note.id },
                data: {
                  status: "delivered",
                  deliveredAt: new Date(),
                  attempts: { increment: 1 },
                },
              });
            } catch {
              await tx.notification.update({
                where: { id: note.id },
                data: {
                  attempts: { increment: 1 },
                  status: note.attempts >= 4 ? "failed" : "pending",
                  nextAt: new Date(Date.now() + 1000 * 2 ** note.attempts),
                },
              });
            }
          }
        },
        { timeout: 30000 },
      );
    } finally {
      this.busy = false;
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await new Promise((r) => setTimeout(r, 20));
  }
}
@Controller()
@UseGuards(AuthGuard)
class Api {
  constructor(private readonly db: Database) {}
  @Post("v1/employees") async create(
    @Body() body: NewEmployee,
    @Req() req: AuthRequest,
  ) {
    admin(req.actor);
    try {
      return await this.db.employee.create({
        data: {
          ...body,
          email: body.email.toLowerCase(),
          tenantId: req.actor.tenantId,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      )
        throw new ConflictException("Employee already exists");
      throw e;
    }
  }
  @Get("v1/employees") async legacy(@Req() req: AuthRequest) {
    admin(req.actor);
    return this.db.employee.findMany({
      where: { tenantId: req.actor.tenantId },
      orderBy: { id: "asc" },
      take: 100,
      select: { id: true, name: true, email: true },
    });
  }
  @Get("v2/employees") async modern(
    @Req() req: AuthRequest,
    @Query("page") page = "1",
  ) {
    admin(req.actor);
    const current = Math.max(1, Math.min(10000, Number(page) || 1));
    const [items, total] = await this.db.$transaction([
      this.db.employee.findMany({
        where: { tenantId: req.actor.tenantId },
        orderBy: { id: "asc" },
        take: 20,
        skip: (current - 1) * 20,
        select: {
          id: true,
          userId: true,
          name: true,
          email: true,
          createdAt: true,
        },
      }),
      this.db.employee.count({ where: { tenantId: req.actor.tenantId } }),
    ]);
    return { items, total, page: current, pageSize: 20 };
  }
  @Get("v1/me") async me(@Req() req: AuthRequest) {
    const employee = await this.db.employee.findFirst({
      where: { tenantId: req.actor.tenantId, userId: req.actor.sub },
      select: { id: true, name: true, email: true },
    });
    if (!employee) throw new NotFoundException();
    return employee;
  }
  @Patch("v1/employees/:id") async rename(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: Rename,
    @Req() req: AuthRequest,
  ) {
    admin(req.actor);
    const result = await this.db.employee.updateMany({
      where: { id, tenantId: req.actor.tenantId },
      data: body,
    });
    if (!result.count) throw new NotFoundException();
    return { updated: true };
  }
  @Post("v1/announcements") async announce(
    @Body() body: News,
    @Req() req: AuthRequest,
  ) {
    admin(req.actor);
    return this.db.$transaction(async (tx) => {
      const announcement = await tx.announcement.create({
        data: {
          ...body,
          tenantId: req.actor.tenantId,
          authorId: req.actor.sub,
        },
      });
      const employees = await tx.employee.findMany({
        where: { tenantId: req.actor.tenantId },
        select: { userId: true, phone: true },
      });
      await tx.notification.createMany({
        data: employees.map((e) => ({
          tenantId: req.actor.tenantId,
          userId: e.userId,
          phone: e.phone,
          announcementId: announcement.id,
          title: body.title,
        })),
      });
      return announcement;
    });
  }
  @Get("v1/announcements") announcements(@Req() req: AuthRequest) {
    return this.db.announcement.findMany({
      where: { tenantId: req.actor.tenantId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }
  @Get("v1/notifications") notifications(@Req() req: AuthRequest) {
    return this.db.notification.findMany({
      where: { tenantId: req.actor.tenantId, userId: req.actor.sub },
      select: { id: true, title: true, status: true, deliveredAt: true },
      take: 100,
      orderBy: { nextAt: "desc" },
    });
  }
}
@Controller("health")
class Health {
  constructor(private readonly db: Database) {}
  @Get("live") live() {
    return { status: "alive" };
  }
  @Get("ready") async ready() {
    await this.db.employee.count();
    return { status: "ready" };
  }
}
@Module({
  controllers: [Api, Health],
  providers: [Database, Delivery, AuthGuard],
})
export class AppModule {}
