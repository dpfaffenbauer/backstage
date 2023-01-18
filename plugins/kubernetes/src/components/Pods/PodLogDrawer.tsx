/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React from 'react';
import { V1Pod } from '@kubernetes/client-node';
import { KubernetesDrawer } from '../KubernetesDrawer/KubernetesDrawer';
import {
  ClientPodLog,
  ClientPodLogUrl,
} from '@backstage/plugin-kubernetes-common';
import { LogViewer } from '@backstage/core-components';
/** @public */
export const PodLogDrawer = (props: {
  pod: V1Pod;
  urls: Map<string, ClientPodLogUrl> | undefined;
  logs: Map<string, ClientPodLog> | undefined;
  expanded?: boolean;
}) => {
  const { pod, urls, logs, expanded } = props;

  const renderLog = () => {
    if (!logs) {
      return <div>No Log entires found</div>;
    }

    if (!urls) {
      return <div>No URLs entires found</div>;
    }

    const entries = [...logs.values()];
    const urlEntries = [...urls.values()];

    return (
      <>
        <div>{urlEntries[0].url}</div>
        <LogViewer text={entries[0].log} />
      </>
    );
  };

  return (
    <KubernetesDrawer
      object={pod}
      expanded={expanded}
      kind="Pod"
      contentChildren={renderLog}
      renderObject={() => {
        return {};
      }}
    />
  );
};
