ALTER TABLE "bots" ADD COLUMN "modelCredentialId" TEXT;

-- Preserve existing explicit compatible choices before a second connection is added.
-- Keep deleted IDs as tombstones: a bound bot must fail rather than switch credentials.
UPDATE "bots" b
SET "modelCredentialId" = (
  SELECT c.id FROM "user_model_credentials" c
  LEFT JOIN "space_model_preferences" p
    ON p."credentialId" = c.id AND p."spaceId" = b."spaceId" AND p."userId" = b."userId"
  WHERE c."userId" = b."userId" AND c.provider = b."modelProvider"
  ORDER BY (p."modelId" = b."modelId") DESC NULLS LAST,
    (p.id IS NOT NULL) DESC, p."isDefault" DESC NULLS LAST,
    p."updatedAt" DESC NULLS LAST, p.id DESC NULLS LAST,
    c."updatedAt" DESC, c."createdAt" DESC, c.id DESC
  LIMIT 1
)
WHERE b."modelProvider" = 'openai-compatible' AND b."modelId" IS NOT NULL;
