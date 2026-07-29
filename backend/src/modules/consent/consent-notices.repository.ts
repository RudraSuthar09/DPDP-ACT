import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { NoticeLanguageCode } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * Persistence for Notice management (FR-CON-02). A notice VERSION belongs to
 * exactly one consent purpose; each version carries many per-language
 * TRANSLATIONS. Both tables are append-only (I4) — there is no update path
 * here at all, only create/read. "Editing a notice" means publishing a new
 * version (all its translations together); nothing already published is ever
 * rewritten. See 1737001300000_consent-purposes-and-notices.sql.
 */

export interface NoticeVersionRow {
  id: string;
  purpose_id: string;
  version_number: number;
  created_at: Date;
  created_by: string | null;
}

export interface NoticeTranslationRow {
  id: string;
  notice_version_id: string;
  language: NoticeLanguageCode;
  body: string;
  created_at: Date;
}

export interface NoticeTranslationInput {
  language: NoticeLanguageCode;
  body: string;
}

export interface NoticeVersionWithTranslations {
  version: NoticeVersionRow;
  translations: NoticeTranslationRow[];
}

@Injectable()
export class ConsentNoticesRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /**
   * Publish a new notice version (all its translations together) for a
   * purpose. Locks the PURPOSE row `FOR UPDATE` — notices have no lifecycle
   * row of their own to lock, so the parent purpose is the natural
   * serialisation point for "what is the next version_number", exactly as
   * `inventory_register_entries`/`consent_purposes` themselves are locked
   * before appending their own next version. Returns null if the purpose
   * doesn't exist or has been tombstoned (a tombstoned purpose is frozen).
   */
  create(
    purposeId: string,
    translations: NoticeTranslationInput[],
    actorId: string | null,
  ): Promise<NoticeVersionWithTranslations | null> {
    return this.db.withTenant(async (client) => {
      const { rows: purposeRows } = await client.query<{ status: string }>(
        `SELECT status FROM consent_purposes WHERE id = $1 FOR UPDATE`,
        [purposeId],
      );
      const purpose = purposeRows[0];
      if (!purpose || purpose.status !== 'active') {
        return null;
      }

      const nextNumber = await this.nextVersionNumber(client, purposeId);

      const { rows: versionRows } = await client.query<NoticeVersionRow>(
        `INSERT INTO consent_notice_versions (purpose_id, version_number, created_by)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [purposeId, nextNumber, actorId],
      );
      const version = versionRows[0]!;

      const translationRows: NoticeTranslationRow[] = [];
      for (const t of translations) {
        const { rows } = await client.query<NoticeTranslationRow>(
          `INSERT INTO consent_notice_translations (notice_version_id, language, body)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [version.id, t.language, t.body],
        );
        translationRows.push(rows[0]!);
      }

      return { version, translations: translationRows };
    });
  }

  private async nextVersionNumber(client: PoolClient, purposeId: string): Promise<number> {
    const { rows } = await client.query<{ version_number: number }>(
      `SELECT version_number FROM consent_notice_versions
        WHERE purpose_id = $1
        ORDER BY version_number DESC
        LIMIT 1`,
      [purposeId],
    );
    return (rows[0]?.version_number ?? 0) + 1;
  }

  /** Every notice version for a purpose, newest first, each with its translations. */
  listForPurpose(purposeId: string): Promise<NoticeVersionWithTranslations[]> {
    return this.db.withTenant(async (client) => {
      const { rows: versions } = await client.query<NoticeVersionRow>(
        `SELECT * FROM consent_notice_versions
          WHERE purpose_id = $1
          ORDER BY version_number DESC`,
        [purposeId],
      );
      if (versions.length === 0) {
        return [];
      }

      const { rows: translations } = await client.query<NoticeTranslationRow>(
        `SELECT * FROM consent_notice_translations
          WHERE notice_version_id = ANY($1::uuid[])
          ORDER BY language`,
        [versions.map((v) => v.id)],
      );

      const byVersion = new Map<string, NoticeTranslationRow[]>();
      for (const t of translations) {
        const list = byVersion.get(t.notice_version_id);
        if (list) {
          list.push(t);
        } else {
          byVersion.set(t.notice_version_id, [t]);
        }
      }

      return versions.map((version) => ({
        version,
        translations: byVersion.get(version.id) ?? [],
      }));
    });
  }

  /** One notice version plus its translations — the first-class notice_version_id lookup. */
  findOne(noticeVersionId: string): Promise<NoticeVersionWithTranslations | null> {
    return this.db.withTenant(async (client) => {
      const { rows: versionRows } = await client.query<NoticeVersionRow>(
        `SELECT * FROM consent_notice_versions WHERE id = $1`,
        [noticeVersionId],
      );
      const version = versionRows[0];
      if (!version) {
        return null;
      }

      const { rows: translations } = await client.query<NoticeTranslationRow>(
        `SELECT * FROM consent_notice_translations
          WHERE notice_version_id = $1
          ORDER BY language`,
        [noticeVersionId],
      );

      return { version, translations };
    });
  }
}
