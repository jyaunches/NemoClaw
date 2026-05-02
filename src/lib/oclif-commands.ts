// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ChannelsAddCommand,
  ChannelsRemoveCommand,
  ChannelsStartCommand,
  ChannelsStopCommand,
} from "./channels-mutate-cli-commands";
import {
  CredentialsCommand,
  CredentialsListCommand,
  CredentialsResetCommand,
} from "./credentials-cli-command";
import ConnectCliCommand from "./connect-cli-command";
import DebugCliCommand from "./debug-cli-command";
import DestroyCliCommand from "./destroy-cli-command";
import GatewayTokenCliCommand from "./gateway-token-cli-command";
import ListCommand from "./list-command";
import {
  BackupAllCommand,
  GarbageCollectImagesCommand,
  UpgradeSandboxesCommand,
} from "./maintenance-cli-commands";
import { PolicyAddCommand, PolicyRemoveCommand } from "./policy-mutate-cli-commands";
import RebuildCliCommand from "./rebuild-cli-command";
import {
  SandboxChannelsListCommand,
  SandboxConfigGetCommand,
  SandboxPolicyListCommand,
  SandboxStatusCommand,
} from "./sandbox-inspection-cli-command";
import SandboxLogsCommand from "./sandbox-logs-cli-command";
import {
  ShieldsDownCommand,
  ShieldsStatusCommand,
  ShieldsUpCommand,
} from "./shields-cli-commands";
import ShareCommand from "./share-command";
import SkillInstallCliCommand from "./skill-install-cli-command";
import {
  SnapshotCreateCommand,
  SnapshotListCommand,
  SnapshotRestoreCommand,
} from "./snapshot-cli-commands";
import StatusCommand from "./status-command";
import {
  DeprecatedStartCommand,
  DeprecatedStopCommand,
  TunnelStartCommand,
  TunnelStopCommand,
} from "./tunnel-commands";
import UninstallCliCommand from "./uninstall-cli-command";

export default {
  "backup-all": BackupAllCommand,
  credentials: CredentialsCommand,
  "credentials:list": CredentialsListCommand,
  "credentials:reset": CredentialsResetCommand,
  debug: DebugCliCommand,
  list: ListCommand,
  "sandbox:channels:add": ChannelsAddCommand,
  "sandbox:channels:list": SandboxChannelsListCommand,
  "sandbox:channels:remove": ChannelsRemoveCommand,
  "sandbox:channels:start": ChannelsStartCommand,
  "sandbox:channels:stop": ChannelsStopCommand,
  "sandbox:config:get": SandboxConfigGetCommand,
  "sandbox:connect": ConnectCliCommand,
  "sandbox:destroy": DestroyCliCommand,
  "sandbox:logs": SandboxLogsCommand,
  "sandbox:policy-add": PolicyAddCommand,
  "sandbox:policy-list": SandboxPolicyListCommand,
  "sandbox:policy-remove": PolicyRemoveCommand,
  "sandbox:rebuild": RebuildCliCommand,
  "sandbox:shields:down": ShieldsDownCommand,
  "sandbox:shields:status": ShieldsStatusCommand,
  "sandbox:shields:up": ShieldsUpCommand,
  "sandbox:skill:install": SkillInstallCliCommand,
  "sandbox:snapshot:create": SnapshotCreateCommand,
  "sandbox:snapshot:list": SnapshotListCommand,
  "sandbox:snapshot:restore": SnapshotRestoreCommand,
  "sandbox:status": SandboxStatusCommand,
  share: ShareCommand,
  status: StatusCommand,
  start: DeprecatedStartCommand,
  stop: DeprecatedStopCommand,
  "sandbox:gateway-token": GatewayTokenCliCommand,
  "tunnel:start": TunnelStartCommand,
  "tunnel:stop": TunnelStopCommand,
  gc: GarbageCollectImagesCommand,
  uninstall: UninstallCliCommand,
  "upgrade-sandboxes": UpgradeSandboxesCommand,
};
