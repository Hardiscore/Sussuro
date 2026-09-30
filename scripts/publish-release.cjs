/**
 * Sussurro - Publicador Automático de Release
 * Garante que a release gerada pelo electron-builder seja tirada de 'draft'
 * e marcada como 'Latest', permitindo que o auto-updater detecte a nova versão.
 */

const fs = require('fs');
const path = require('path');

async function main() {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = pkg.version;
  const targetTag = 'v' + version;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (!token) {
    console.warn('[PublishRelease] Nenhum GITHUB_TOKEN configurado no ambiente. Pulando finalização.');
    return;
  }

  const owner = 'Hardiscore';
  const repo = 'Sussuro';
  const url = `https://api.github.com/repos/${owner}/${repo}/releases`;

  console.log(`[PublishRelease] Buscando releases para versão ${version} (${targetTag})...`);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Sussurro-Release-Agent'
    }
  });

  if (!res.ok) {
    console.warn(`[PublishRelease] Erro ao listar releases: ${res.status} ${await res.text()}`);
    return;
  }

  const releases = await res.json();
  const targetRelease = releases.find(r => 
    r.tag_name === targetTag || 
    r.tag_name === version || 
    r.name === version || 
    r.name === targetTag
  );

  if (!targetRelease) {
    console.log(`[PublishRelease] Release ${targetTag} não encontrada na listagem.`);
    return;
  }

  console.log(`[PublishRelease] Release encontrada: ID=${targetRelease.id}, Tag=${targetRelease.tag_name}, Draft=${targetRelease.draft}`);

  if (targetRelease.draft) {
    console.log(`[PublishRelease] Publicando a Release (removendo estado Draft e tornando Latest)...`);
    const patchRes = await fetch(`${url}/${targetRelease.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Sussurro-Release-Agent'
      },
      body: JSON.stringify({
        draft: false,
        make_latest: 'true'
      })
    });

    if (patchRes.ok) {
      console.log(`[PublishRelease] SUCESSO! A versão ${version} foi publicada e marcada como Latest no GitHub!`);
    } else {
      console.warn(`[PublishRelease] Falha ao publicar release: ${patchRes.status} ${await patchRes.text()}`);
    }
  } else {
    console.log(`[PublishRelease] A release ${targetRelease.tag_name} já é pública e ativa.`);
  }
}

main().catch(err => {
  console.error('[PublishRelease] Erro:', err);
  process.exit(1);
});
